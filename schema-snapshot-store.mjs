import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryTimeouts } from './recovery.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function sealSnapshot(record) {
  const { sha256: ignored, ...payload } = record;
  return { ...payload, sha256: hash(JSON.stringify(payload)) };
}

export function validateSnapshot(record, version, target) {
  if (![1, 2].includes(record.format) || record.version !== String(version)
      || JSON.stringify(record.target) !== JSON.stringify(target) || !record.tables
      || typeof record.tables !== 'object' || Array.isArray(record.tables)
      || (record.format === 2 && record.sha256 !== sealSnapshot(record).sha256)) {
    throw new Error(`Schema snapshot before ${version} is invalid or belongs to a different target.`);
  }
  return record;
}

export function snapshotStore(root, version, target, { env = process.env, spawn = spawnSync } = {}) {
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]+)\/(.+)$/.exec(env.MIGRATION_RECOVERY_S3_URI || '');
  if (!match) throw new Error('Durable schema snapshots require MIGRATION_RECOVERY_S3_URI.');
  if (!/^\d+$/.test(String(version))) throw new Error('Invalid schema snapshot version.');
  const key = `${match[2].replace(/\/$/, '')}/schema-metadata/${hash(JSON.stringify(target))}/${version}.json`;
  const base = ['--bucket', match[1], '--key', key];
  function command(args) {
    return spawn(env.MIGRATION_AWS_BIN || 'aws', ['s3api', ...args], {
      encoding: 'utf8', shell: false, timeout: recoveryTimeouts(env).s3,
      maxBuffer: 1024 * 1024, env: { ...env, AWS_PAGER: '' },
    });
  }
  function temporary() {
    const path = join(root, `.schema-${randomUUID()}.json`);
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    return path;
  }
  function read() {
    const path = temporary();
    try {
      const result = command(['get-object', ...base, path]);
      if (result.error || result.status !== 0) {
        if (!result.error && /\(NoSuchKey\)/.test(result.stderr || '')) return undefined;
        throw new Error('Durable schema snapshot download failed; permissions or connectivity must be repaired before writes.');
      }
      const record = validateSnapshot(JSON.parse(readFileSync(path, 'utf8')), version, target);
      if (record.format !== 2) throw new Error('Remote schema snapshot has no verified checksum.');
      return record;
    } finally { if (existsSync(path)) unlinkSync(path); }
  }
  function same(left, right) {
    if (JSON.stringify(left.tables) !== JSON.stringify(right.tables)) {
      throw new Error('A different pre-migration schema snapshot already exists; do not overwrite historical evidence.');
    }
  }
  function save(record) {
    const existing = read();
    if (existing) { same(existing, record); return existing; }
    const path = temporary();
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('Snapshot symlinks are forbidden.');
      writeFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 });
      const encryption = env.MIGRATION_RECOVERY_KMS_KEY
        ? ['--server-side-encryption', 'aws:kms', '--ssekms-key-id', env.MIGRATION_RECOVERY_KMS_KEY]
        : ['--server-side-encryption', 'AES256'];
      const result = command(['put-object', ...base, '--body', path, '--if-none-match', '*', ...encryption]);
      if (result.error || (result.status !== 0 && !/\(PreconditionFailed\)/.test(result.stderr || ''))) {
        throw new Error('Durable schema snapshot upload failed; migration writes are blocked.');
      }
      const verified = read();
      if (!verified) throw new Error('Uploaded schema snapshot is unavailable; writes are blocked.');
      same(verified, record);
      return verified;
    } finally { if (existsSync(path)) unlinkSync(path); }
  }
  return { read, save };
}
