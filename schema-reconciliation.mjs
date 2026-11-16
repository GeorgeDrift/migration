import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const defaultRoot = fileURLToPath(new URL('.', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const identity = databases => JSON.stringify([databases.dev, databases.target].map(
  ({ host, port, schema, user }) => ({ host, port, schema, user }),
));

function journal(root) {
  const policyText = readFileSync(join(root, 'migration-policy.json'), 'utf8');
  const policy = JSON.parse(policyText);
  const names = readdirSync(join(root, 'migrations')).filter(name => name.endsWith('.sql')).sort();
  if (names.length !== Object.keys(policy).length) throw new Error('Migration policy and files differ; reconcile history manually first.');
  const files = names.map(name => {
    const entry = policy[name];
    const sha256 = hash(readFileSync(join(root, 'migrations', name)));
    if (!/^\d+_.+\.sql$/.test(name) || entry?.sha256 !== sha256 || entry.scope !== 'schema'
        || !['additive', 'destructive'].includes(entry.risk)) {
      throw new Error('Existing migration approvals are invalid; no automatic registration is allowed.');
    }
    return { name, sha256 };
  });
  const sumPath = join(root, 'migrations', 'atlas.sum');
  const sum = existsSync(sumPath) ? readFileSync(sumPath, 'utf8') : undefined;
  const downPath = join(root, 'down-migrations');
  const reverse = existsSync(downPath) ? readdirSync(downPath).filter(name => name.endsWith('.sql')).sort()
    .map(name => ({ name, sha256: hash(readFileSync(join(downPath, name))) })) : [];
  return { policy, policyText, names, sum, fingerprint: hash(JSON.stringify({ policyText, files, sum, reverse })) };
}

function generatedSql(root, spawn, replayCorrection = false) {
  const result = spawn(process.execPath, ['schema-diff.mjs', ...(replayCorrection ? ['--replay-correction'] : [])], {
    cwd: root, env: process.env, encoding: 'utf8', timeout: 120000,
    maxBuffer: 32 * 1024 * 1024, shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Read-only schema SQL generation failed. No SQL was registered or applied.');
  }
  const sql = (result.stdout || '').trim();
  if (!sql || !/\b(?:CREATE|ALTER|DROP)\b/i.test(sql)) {
    throw new Error('Schema mismatch has no supported generated correction. Manual SQL review is required.');
  }
  return sql + '\n';
}

// Reverse SQL powers fast schema undo. Without it the migration still works; undo needs a checkpoint.
function reverseSql(root, spawn, replayCorrection) {
  if (replayCorrection) return undefined;
  const result = spawn(process.execPath, ['schema-diff.mjs', '--reverse'], {
    cwd: root, env: process.env, encoding: 'utf8', timeout: 120000,
    maxBuffer: 32 * 1024 * 1024, shell: false,
  });
  const sql = (result.stdout || '').trim();
  if (result.error || result.status !== 0 || !sql || !/\b(?:CREATE|ALTER|DROP)\b/i.test(sql)) return undefined;
  return sql + '\n';
}

export function proposeReconciliation(databases, { root = defaultRoot, spawn = spawnSync, replayCorrection = false } = {}) {
  const before = journal(root);
  const sql = generatedSql(root, spawn, replayCorrection);
  const downSql = reverseSql(root, spawn, replayCorrection);
  if (journal(root).fingerprint !== before.fingerprint) throw new Error('Migration files changed during SQL generation; preview again.');
  return { sql, sha256: hash(sql), risk: 'destructive', identity: identity(databases),
    ...(downSql ? { downSql, downSha256: hash(downSql) } : {}),
    journalFingerprint: before.fingerprint, replayCorrection };
}

export function approveReconciliation(proposal, databases, {
  root = defaultRoot, spawn = spawnSync, now = new Date(),
} = {}) {
  if (proposal.identity !== identity(databases) || hash(proposal.sql) !== proposal.sha256
      || (proposal.downSql !== undefined && hash(proposal.downSql) !== proposal.downSha256)) {
    throw new Error('Schema proposal or target changed; preview again before approval.');
  }
  const lockPath = join(root, '.schema-review.lock');
  const lock = openSync(lockPath, 'wx', 0o600);
  let name;
  let snapshot;
  let writtenPolicy;
  let registrationStarted = false;
  try {
    snapshot = journal(root);
    if (snapshot.fingerprint !== proposal.journalFingerprint) throw new Error('Migration history changed; preview again.');
    // Bind approval to a fresh diff rather than applying SQL from a stale preview.
    if (hash(generatedSql(root, spawn, proposal.replayCorrection)) !== proposal.sha256) throw new Error('Live schema SQL changed since preview; approval cancelled.');
    const liveDown = reverseSql(root, spawn, proposal.replayCorrection);
    if ((liveDown && hash(liveDown)) !== (proposal.downSql && proposal.downSha256)) {
      throw new Error('Live reverse SQL changed since preview; approval cancelled.');
    }
    if (journal(root).fingerprint !== snapshot.fingerprint) throw new Error('Migration files changed during approval.');
    let version = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const previous = snapshot.names.map(file => file.split('_')[0]).sort().at(-1);
    if (previous && BigInt(version) <= BigInt(previous)) version = (BigInt(previous) + 1n).toString();
    if (previous && version.localeCompare(previous) <= 0) throw new Error('Cannot safely append this version; review the migration numbering.');
    name = version + '_reconcile_source_schema.sql';
    const sqlPath = join(root, 'migrations', name);
    writeFileSync(sqlPath, proposal.sql, { flag: 'wx', mode: 0o600 });
    registrationStarted = true;
    if (proposal.downSql) {
      mkdirSync(join(root, 'down-migrations'), { recursive: true });
      writeFileSync(join(root, 'down-migrations', name), proposal.downSql, { flag: 'wx', mode: 0o600 });
    }
    writtenPolicy = JSON.stringify({ ...snapshot.policy, [name]: {
      sha256: proposal.sha256, scope: 'schema', risk: 'destructive',
      ...(proposal.downSql ? { down: { sha256: proposal.downSha256, risk: 'destructive' } } : {}),
    } }, null, 2) + '\n';
    writeFileSync(join(root, 'migration-policy.json'), writtenPolicy);
    const result = spawn(process.env.ATLAS_BIN || 'atlas', [
      'migrate', 'hash', '--dir', 'file://migrations',
    ], { cwd: root, env: process.env, encoding: 'utf8', timeout: 30000, shell: false });
    if (result.error || result.status !== 0) throw new Error('Atlas checksum generation failed; registration cancelled.');
    const after = journal(root);
    if (after.policyText !== writtenPolicy) throw new Error('Migration policy changed while registering the approved SQL.');
    return { name, sha256: proposal.sha256, risk: 'destructive', reversible: Boolean(proposal.downSql) };
  } catch (error) {
    if (registrationStarted) {
      const path = join(root, 'migrations', name);
      if (existsSync(path) && hash(readFileSync(path)) === proposal.sha256) unlinkSync(path);
      const downPath = join(root, 'down-migrations', name);
      if (proposal.downSql && existsSync(downPath) && hash(readFileSync(downPath)) === proposal.downSha256) unlinkSync(downPath);
      const policyPath = join(root, 'migration-policy.json');
      if (readFileSync(policyPath, 'utf8') === writtenPolicy) writeFileSync(policyPath, snapshot.policyText);
      // Do not overwrite a checksum file another operator may have changed.
      // A failed hash leaves execution blocked until the journal is revalidated.
    }
    throw error;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
