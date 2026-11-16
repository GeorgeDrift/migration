import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { databaseConfigs, localOnly, passwordFor, readCa, sslFor } from './database-config.mjs';

const idPattern = /^\d{13}-[0-9a-f-]{36}$/;
const repository = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');

export function fileHash(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

export function targetIdentity(config) {
  return { host: config.host, port: config.port, schema: config.schema };
}

// One target-wide lock serializes migrations, restores and schema undo.
export function recoveryLockName(config) {
  return 'fabla:recovery:' + digest(JSON.stringify(targetIdentity(config))).slice(0, 40);
}

export function validateIdentity(checkpoint, databases) {
  if (JSON.stringify(checkpoint.target) !== JSON.stringify(targetIdentity(databases.target))
      || (checkpoint.target.schema === databases.dev.schema
        && checkpoint.target.host.toLowerCase() === databases.dev.host.toLowerCase()
        && checkpoint.target.port === databases.dev.port)) {
    throw new Error('Checkpoint target does not match the configured target; source restoration is forbidden.');
  }
}

export function recoveryDirectory(env = process.env) {
  const path = env.MIGRATION_RECOVERY_DIR;
  if (!path || !isAbsolute(path)) throw new Error('Set MIGRATION_RECOVERY_DIR to an absolute directory.');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const root = realpathSync(path);
  const repo = realpathSync(repository);
  const inside = relative(repo, root);
  if ((!inside || (!inside.startsWith('..' + sep) && inside !== '..' && !isAbsolute(inside))) && !localOnly(env)) {
    throw new Error('Production recovery backups contain database records and must be stored outside the repository.');
  }
  return root;
}

function artifact(root, id, extension) {
  if (!idPattern.test(id)) throw new Error('Invalid checkpoint ID.');
  const path = join(root, `${id}.${extension}`);
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path)) {
    throw new Error('Checkpoint symlinks are forbidden.');
  }
  return path;
}

export function readCheckpoint(root, id, databases, env = process.env) {
  const checkpoint = JSON.parse(readFileSync(artifact(root, id, 'json'), 'utf8'));
  if (checkpoint.format !== 1 || checkpoint.id !== id || checkpoint.status !== 'ready'
      || !['stage', 'rescue'].includes(checkpoint.kind)
      || !/^[0-9a-f]{64}$/.test(checkpoint.sha256) || !checkpoint.remote) {
    throw new Error('Checkpoint is incomplete or invalid.');
  }
  if (checkpoint.storage === 'local' && !localOnly(env)) throw new Error('Local checkpoints require loopback local-only mode.');
  validateIdentity(checkpoint, databases);
  if (fileHash(artifact(root, id, 'sql')) !== checkpoint.sha256) {
    throw new Error('Checkpoint SQL checksum differs; restore is blocked.');
  }
  return checkpoint;
}

export function listCheckpoints(root, databases) {
  return readdirSync(root).filter(name => name.endsWith('.json') && idPattern.test(name.slice(0, -5)))
    .map(name => readCheckpoint(root, name.slice(0, -5), databases))
    .filter(checkpoint => checkpoint.kind === 'stage')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function selectCheckpoint(checkpoints, steps) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 3) throw new Error('Rollback steps must be 1, 2, or 3.');
  if (!checkpoints[steps - 1]) throw new Error(`Only ${checkpoints.length} stage checkpoints are available; cannot restore ${steps} steps.`);
  return checkpoints[steps - 1];
}

function optionValue(value) {
  return '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    .replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
}

export function clientOptions(config, password, caPath) {
  return '[client]\n' + Object.entries({
    host: config.host, port: config.port, user: config.user, password,
    ...(caPath ? { 'ssl-ca': caPath, 'ssl-verify-server-cert': 1 } : {}),
    'default-character-set': 'utf8mb4',
  }).map(([key, value]) => `${key}=${optionValue(value)}`).join('\n') + '\n';
}

export function dumpArguments(defaults, schema) {
  return [`--defaults-extra-file=${defaults}`, '--single-transaction', '--quick',
    '--routines', '--triggers', '--events', '--hex-blob', '--order-by-primary',
    '--skip-comments', '--skip-dump-date', '--skip-extended-insert', '--skip-add-locks',
    '--add-drop-database', '--databases', schema];
}

export function recoveryTimeouts(env = process.env) {
  return Object.fromEntries(['DUMP', 'RESTORE', 'S3'].map(kind => {
    const name = `MIGRATION_${kind}_TIMEOUT_MS`;
    const value = env[name] ?? '300000';
    if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 86400000) {
      throw new Error(`${name} must be an integer from 1 to 86400000 milliseconds.`);
    }
    return [kind.toLowerCase(), Number(value)];
  }));
}

export async function createRecovery(databases, ca, {
  env = process.env, connect = mysql.createConnection, spawn = spawnSync, print = console.log,
} = {}) {
  const target = databases.target;
  const local = localOnly(env);
  const timeouts = recoveryTimeouts(env);
  if (env.MIGRATION_MAINTENANCE_TARGET !== target.schema) {
    throw new Error(`Pause all target writers, then set MIGRATION_MAINTENANCE_TARGET=${target.schema}.`);
  }
  if (!local && !/^s3:\/\/[a-z0-9][a-z0-9.-]+\/.+/.test(env.MIGRATION_RECOVERY_S3_URI || '')) {
    throw new Error('Set MIGRATION_RECOVERY_S3_URI to a private approved S3 bucket/prefix. Durable recovery is required before writes.');
  }
  const root = recoveryDirectory(env);
  const password = passwordFor(target, env);
  if (password === undefined || (!local && !env.RDS_CA_BUNDLE)) throw new Error('Target password and RDS_CA_BUNDLE are required for recovery.');
  const db = await connect({
    host: target.host, port: target.port, database: target.schema, user: target.user,
    password, ssl: sslFor(target, ca), connectTimeout: 15000,
  });
  const token = randomUUID();
  const lock = recoveryLockName(target);
  const previousLease = env.MIGRATION_RECOVERY_LEASE;
  const defaults = join(root, `.client-${token}.cnf`);
  let owner;
  let first;
  let last;
  let acquired = false;
  function command(binary, args, stdio = ['ignore', 'pipe', 'pipe'], timeout = timeouts.s3) {
    const result = spawn(binary, args, {
      stdio, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
      env: { ...env, AWS_PAGER: '' }, shell: false,
    });
    if (result.error || result.status !== 0) {
      // Never print client stderr: it can contain database values or credentials.
      throw new Error(`${binary} failed (${result.error?.code || result.status}). Check permissions, client installation and connectivity; no success is assumed.`);
    }
  }
  function dump(path) {
    const fd = openSync(path, 'wx', 0o600);
    try { command(env.MIGRATION_DUMP_BIN || 'mariadb-dump', dumpArguments(defaults, target.schema), ['ignore', fd, 'pipe'], timeouts.dump); }
    finally { closeSync(fd); }
    if (!statSync(path).size) throw new Error('Empty database dump; writes are blocked.');
  }
  function upload(path, uri) {
    const encryption = env.MIGRATION_RECOVERY_KMS_KEY
      ? ['--sse', 'aws:kms', '--sse-kms-key-id', env.MIGRATION_RECOVERY_KMS_KEY] : ['--sse', 'AES256'];
    command(env.MIGRATION_AWS_BIN || 'aws', ['s3', 'cp', path, uri, '--only-show-errors', ...encryption]);
    const verification = join(root, `.verify-${randomUUID()}`);
    writeFileSync(verification, '', { flag: 'wx', mode: 0o600 });
    try {
      command(env.MIGRATION_AWS_BIN || 'aws', ['s3', 'cp', uri, verification, '--only-show-errors']);
      if (fileHash(verification) !== fileHash(path)) throw new Error('Durable S3 backup verification failed.');
    } finally { if (existsSync(verification)) unlinkSync(verification); }
  }
  async function assertSafe() {
    const [[held]] = await db.execute('SELECT IS_USED_LOCK(?) AS owner', [lock]);
    if (String(held.owner) !== String(owner)) throw new Error('Recovery lock was lost; writes and restore are blocked.');
    const [foreignKeys] = await db.execute(
      'SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA IS NOT NULL AND ((TABLE_SCHEMA = ? AND REFERENCED_TABLE_SCHEMA <> ?) OR (REFERENCED_TABLE_SCHEMA = ? AND TABLE_SCHEMA <> ?))',
      [target.schema, target.schema, target.schema, target.schema],
    );
    if (foreignKeys.length) throw new Error('Cross-database foreign keys require manual recovery; automatic target reset is blocked.');
    const [engines] = await db.execute(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND (TABLE_TYPE NOT IN ('BASE TABLE', 'VIEW') OR (TABLE_TYPE = 'BASE TABLE' AND (ENGINE IS NULL OR ENGINE <> 'InnoDB')))", [target.schema],
    );
    if (engines.length) throw new Error('Recovery requires InnoDB base tables and views only; unsupported table types require manual recovery.');
    const [events] = await db.execute('SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?', [target.schema]);
    if (events.length) throw new Error('Scheduled target events require manual review before automatic recovery.');
  }
  async function checkpoint(label, kind = 'stage') {
    await assertSafe();
    const id = `${Date.now()}-${randomUUID()}`;
    const path = artifact(root, id, 'sql');
    dump(path);
    await assertSafe();
    const record = {
      format: 1, id, kind, label, createdAt: new Date().toISOString(), status: 'ready',
      target: targetIdentity(target), sha256: fileHash(path),
      remote: local ? 'local:' + id : env.MIGRATION_RECOVERY_S3_URI.replace(/\/$/, '') + '/' + id,
      storage: local ? 'local' : 's3',
      lock, owner: String(owner), token,
    };
    // Publish and verify SQL before publishing the ready manifest.
    if (!local) upload(path, record.remote + '.sql');
    await assertSafe();
    writeFileSync(artifact(root, id, 'json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try {
      if (!local) upload(artifact(root, id, 'json'), record.remote + '.json');
      await assertSafe();
    }
    catch (error) { unlinkSync(artifact(root, id, 'json')); throw error; }
    if (kind === 'stage') {
      first ||= record;
      last = record;
      env.MIGRATION_RECOVERY_LEASE = JSON.stringify({ root, id, token, owner: String(owner), lock });
    }
    print(JSON.stringify({ recoveryCheckpoint: id, label, target: target.schema, durable: !local, storage: local ? 'local' : 's3' }));
    return record;
  }
  async function restore(record) {
    const verified = readCheckpoint(root, record.id, databases, env);
    await assertSafe();
    const rescue = await checkpoint(`Before restore of ${record.id}`, 'rescue');
    const fd = openSync(artifact(root, verified.id, 'sql'), 'r');
    try { command(env.MIGRATION_SQL_BIN || 'mariadb', [`--defaults-extra-file=${defaults}`], [fd, 'pipe', 'pipe'], timeouts.restore); }
    catch (error) {
      throw new Error(`Restore failed; target may be partial. Preserve checkpoint ${verified.id} and rescue ${rescue.id}. ${error.message}`);
    } finally { closeSync(fd); }
    const comparison = join(root, `.restored-${randomUUID()}.sql`);
    try {
      dump(comparison);
      await assertSafe();
      if (fileHash(comparison) !== verified.sha256) {
        throw new Error(`Restored target does not reproduce checkpoint ${verified.id}; do not resume migration. Rescue checkpoint: ${rescue.id}.`);
      }
    } finally { if (existsSync(comparison)) unlinkSync(comparison); }
    print(JSON.stringify({ restoredCheckpoint: verified.id, target: target.schema, verified: true }));
    return verified;
  }
  async function close() {
    if (previousLease === undefined) delete env.MIGRATION_RECOVERY_LEASE;
    else env.MIGRATION_RECOVERY_LEASE = previousLease;
    try { if (acquired) await db.execute('SELECT RELEASE_LOCK(?)', [lock]); }
    catch { print('Recovery lock release failed; closing its connection. Check connectivity before another run.'); }
    finally {
      await db.end().catch(() => {});
      if (existsSync(defaults)) unlinkSync(defaults);
    }
  }
  try {
    const [[result]] = await db.execute('SELECT GET_LOCK(?, 0) AS acquired, CONNECTION_ID() AS owner', [lock]);
    if (Number(result.acquired) !== 1) throw new Error('Another migration or restore owns the target recovery lock.');
    acquired = true;
    owner = result.owner;
    writeFileSync(defaults, clientOptions(target, password, local ? undefined : env.RDS_CA_BUNDLE), { flag: 'wx', mode: 0o600 });
    await assertSafe();
    return { root, checkpoint, restore, close, assertSafe, get first() { return first; }, get last() { return last; } };
  } catch (error) { await close(); throw error; }
}

export async function assertRecoveryLease(databases = databaseConfigs(), env = process.env) {
  if (!env.MIGRATION_RECOVERY_LEASE) {
    throw new Error('Writes require a protected checkpoint. Use tool.mjs or the interactive menu, not standalone --execute.');
  }
  const lease = JSON.parse(env.MIGRATION_RECOVERY_LEASE);
  const root = recoveryDirectory(env);
  if (lease.root !== root) throw new Error('Recovery lease directory differs.');
  const record = readCheckpoint(root, lease.id, databases, env);
  if (record.token !== lease.token || record.owner !== lease.owner || record.lock !== lease.lock) {
    throw new Error('Recovery lease does not match its checkpoint.');
  }
  const config = databases.target;
  const db = await mysql.createConnection({
    host: config.host, port: config.port, database: config.schema, user: config.user,
    password: passwordFor(config, env), ssl: sslFor(config, readCa(env)),
    connectTimeout: 15000,
  });
  try {
    const [[held]] = await db.execute('SELECT IS_USED_LOCK(?) AS owner', [record.lock]);
    if (String(held.owner) !== record.owner) throw new Error('Protected parent migration is no longer running; writes are blocked.');
  } finally { await db.end(); }
}
