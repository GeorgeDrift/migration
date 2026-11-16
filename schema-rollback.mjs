import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DOWN_MARKER, readDownSql } from './migration-policy.mjs';
import { splitStatements } from './numeric-fidelity.mjs';
import { readSchemaMetadata, schemaDifferences } from './schema-metadata.mjs';
import { listApplicationTables } from './schema-stage.mjs';
import { targetIdentity } from './recovery.mjs';
import { sealSnapshot, snapshotStore, validateSnapshot } from './schema-snapshot-store.mjs';

const markerPattern = new RegExp(`^${DOWN_MARKER}(\\d+)/(\\d+)`);
const currentMarkerPattern = new RegExp(`^${DOWN_MARKER}v2:(started|completed):(\\d+)/(\\d+)(?::([a-f0-9]{64}))?`);
const sqlDigest = sql => createHash('sha256').update(sql).digest('hex');

export function undoProgress(error) {
  const current = String(error || '').match(currentMarkerPattern);
  if (current) return { state: current[1], done: Number(current[2]), total: Number(current[3]),
    ...(current[4] ? { sqlSha256: current[4] } : {}) };
  const match = String(error || '').match(markerPattern);
  return match ? { state: 'legacy', done: Number(match[1]), total: Number(match[2]) } : undefined;
}

export function undoMarker(done, total, name, state = 'completed', sqlSha256) {
  return `${DOWN_MARKER}v2:${state}:${done}/${total}${sqlSha256 ? ':' + sqlSha256 : ''} Schema undo of ${name}. `
    + (state === 'started' ? 'Statement outcome is uncertain; inspect the target or restore a verified checkpoint.'
      : 'Acknowledged statements are complete; resume only after revalidating history under the target lock.');
}

// Newest-first undo plan for the last `steps` applied migrations, using only reviewed reverse SQL.
export function planSchemaRollback(migrations, revisions, steps, { readSql = readDownSql } = {}) {
  if (!Number.isInteger(steps) || steps < 1) throw new Error('Undo steps must be a positive integer.');
  const known = new Set(migrations.map(migration => migration.version));
  const byVersion = new Map();
  for (const revision of revisions) {
    const version = String(revision.version);
    if (!known.has(version) || byVersion.has(version)) {
      throw new Error(`Atlas revision history contains an unknown or duplicate version: ${version}`);
    }
    byVersion.set(version, revision);
  }
  const applied = [];
  let gap = false;
  for (const migration of migrations) {
    const revision = byVersion.get(migration.version);
    if (!revision) { gap = true; continue; }
    if (gap) throw new Error('Atlas revision history is out of order; fast undo is unavailable.');
    const progress = undoProgress(revision.error);
    const complete = Number(revision.applied) === Number(revision.total) && !revision.error;
    if (!complete && !progress) {
      throw new Error(`Migration ${migration.name} is only partially applied. Fast undo cannot know its state; inspect it or restore a saved checkpoint.`);
    }
    applied.push({ migration, progress });
  }
  if (applied.slice(0, -1).some(item => item.progress)) {
    throw new Error('An interrupted schema undo is recorded below newer migrations; inspect Atlas history manually.');
  }
  if (!applied.length) throw new Error('The target records no applied migrations; there is nothing to undo.');
  if (steps > applied.length) {
    throw new Error(`Only ${applied.length} applied migration(s) are recorded; cannot undo ${steps}.`);
  }
  const selected = applied.slice(-steps).reverse();
  const missing = selected.filter(item => !item.migration.down).map(item => item.migration.name);
  if (missing.length) {
    throw new Error(`No reviewed reverse SQL for ${missing.join(', ')}. Fast undo is unavailable; use "npm run rollback -- restore" for a saved checkpoint.`);
  }
  const plan = selected.map(({ migration, progress }) => {
    const sql = readSql(migration);
    const statements = splitStatements(sql);
    if (!statements.length) throw new Error(`Reverse SQL for ${migration.name} has no statements.`);
    if (progress && progress.total !== statements.length) {
      throw new Error(`Recorded undo position for ${migration.name} does not match its reverse SQL; inspect it manually.`);
    }
    if (progress && (!Number.isSafeInteger(progress.done) || progress.done < 0 || progress.done > progress.total)) {
      throw new Error(`Invalid undo position for ${migration.name}; writes are blocked.`);
    }
    if (progress && progress.state !== 'completed') {
      throw new Error(`Uncertain reverse statement outcome for ${migration.name}. Do not replay DDL: inspect the current schema and restore a verified checkpoint or reconcile it manually.`);
    }
    if (progress && progress.sqlSha256 !== sqlDigest(sql)) {
      throw new Error(`Interrupted undo SQL for ${migration.name} changed or has no bound checksum; writes are blocked.`);
    }
    return { name: migration.name, version: migration.version, risk: migration.risk,
      reverseRisk: migration.down.risk, sql, statements, completed: progress?.done ?? 0 };
  });
  return {
    migrations: plan,
    oldestVersion: plan.at(-1).version,
    requiresAllowDestructive: plan.some(item => item.risk === 'destructive' || item.reverseRisk === 'destructive'),
  };
}

// An interrupted DDL acknowledgement is ambiguous, even if the server committed it.
export async function applySchemaRollback(db, plan, {
  print = console.log, assertSafe = async () => {}, verifyMigration = async () => {},
} = {}) {
  const undone = [];
  async function record(item, done, state) {
    const [result] = await db.execute('UPDATE atlas_schema_revisions SET error = ? WHERE version = ?',
      [undoMarker(done, item.statements.length, item.name, state, sqlDigest(item.sql)), item.version]);
    if (Number(result.affectedRows) !== 1) throw new Error('Undo history changed; writes are blocked.');
  }
  for (const item of plan.migrations) {
    const total = item.statements.length;
    for (let index = item.completed; index < total; index++) {
      await assertSafe();
      await record(item, index, 'started');
      try {
        await db.query(item.statements[index]);
        await record(item, index + 1, 'completed');
      }
      catch (error) {
        throw new Error(`Reverse statement ${index + 1} of ${total} for ${item.name} failed: ${error.message} `
          + `Fully undone: ${undone.join(', ') || 'none'}. The statement outcome may be uncertain; do not replay it blindly. Inspect history and restore a verified checkpoint if needed.`);
      }
    }
    await assertSafe();
    await verifyMigration(item);
    const [result] = await db.execute('DELETE FROM atlas_schema_revisions WHERE version = ?', [item.version]);
    if (Number(result.affectedRows) !== 1) {
      throw new Error(`Atlas history for ${item.name} could not be removed after its reverse SQL ran; inspect it manually.`);
    }
    undone.push(item.name);
    print(JSON.stringify({ undoneMigration: item.name, statements: total }));
  }
  return undone;
}

export function snapshotPath(root, version) {
  if (!/^\d+$/.test(String(version))) throw new Error('Invalid migration version for a schema snapshot.');
  const path = join(root, `schema-before-${version}.json`);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Schema snapshot symlinks are forbidden.');
  return path;
}

export async function readSchemaState(db, schema) {
  const names = await listApplicationTables(db, schema);
  const metadata = await readSchemaMetadata(db, schema, names);
  return JSON.parse(JSON.stringify(Object.fromEntries(metadata)));
}

export async function saveSchemaSnapshot(db, config, root, version, options = {}) {
  const record = sealSnapshot({ format: 2, version: String(version), target: targetIdentity(config),
    createdAt: new Date().toISOString(), tables: await readSchemaState(db, config.schema) });
  const durable = snapshotStore(root, version, targetIdentity(config), options).save(record);
  writeFileSync(snapshotPath(root, version), JSON.stringify(durable) + '\n', { mode: 0o600 });
  return durable;
}

export function loadSchemaSnapshot(root, version, config, options = {}) {
  const path = snapshotPath(root, version);
  if (!existsSync(path)) {
    if (!(options.env || process.env).MIGRATION_RECOVERY_S3_URI) return undefined;
    const remote = snapshotStore(root, version, targetIdentity(config), options).read();
    if (remote) writeFileSync(path, JSON.stringify(remote) + '\n', { flag: 'wx', mode: 0o600 });
    return remote;
  }
  const record = JSON.parse(readFileSync(path, 'utf8'));
  return validateSnapshot(record, version, targetIdentity(config));
}

export function compareSchemaState(expected, actual) {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    .map(table => ({ table, fields: schemaDifferences(expected[table], actual[table]).map(item => item.field) }))
    .filter(item => item.fields.length);
}
