import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { localOnly } from './database-config.mjs';
import { targetIdentity } from './recovery.mjs';

// Every schema change the tool applies is recorded here for rollback: the SQL that ran, the
// SQL that reverses it, the target schema before and after, and the checkpoint taken first.
// Records live in the recovery directory and in S3; migration never reads them.

const idPattern = /^\d{13}-[0-9a-f-]{36}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function newChangeId(now = Date.now()) {
  return `${now}-${randomUUID()}`;
}

export function changesDirectory(root) {
  const directory = join(root, 'schema-changes');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function s3Location(env, name) {
  const uri = env.MIGRATION_RECOVERY_S3_URI || '';
  if (!/^s3:\/\/[a-z0-9][a-z0-9.-]+\/.+/.test(uri)) {
    throw new Error('Set MIGRATION_RECOVERY_S3_URI; schema change records must be kept durably for rollback.');
  }
  return `${uri.replace(/\/$/, '')}/schema-changes/${name}`;
}

function aws(env, spawn, args) {
  const result = spawn(env.MIGRATION_AWS_BIN || 'aws', args, {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024,
    env: { ...env, AWS_PAGER: '' }, shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`aws ${args.slice(0, 2).join(' ')} failed (${result.error?.code || result.status}). The schema change record is not durable.`);
  }
}

function writeDurably(path, content, { env, spawn }) {
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
  if (localOnly(env)) {
    if (sha256(readFileSync(path)) !== sha256(content)) throw new Error('Local schema change record verification failed.');
    return;
  }
  const uri = s3Location(env, path.split(/[\\/]/).pop());
  const encryption = env.MIGRATION_RECOVERY_KMS_KEY
    ? ['--sse', 'aws:kms', '--sse-kms-key-id', env.MIGRATION_RECOVERY_KMS_KEY] : ['--sse', 'AES256'];
  aws(env, spawn, ['s3', 'cp', path, uri, '--only-show-errors', ...encryption]);
  const check = mkdtempSync(join(tmpdir(), 'fabla-change-check-'));
  try {
    const copy = join(check, 'record.json');
    aws(env, spawn, ['s3', 'cp', uri, copy, '--only-show-errors']);
    if (!existsSync(copy) || sha256(readFileSync(copy)) !== sha256(content)) {
      throw new Error('The S3 copy of the schema change record could not be verified.');
    }
  } finally { rmSync(check, { recursive: true, force: true }); }
}

export function saveChange(root, record, { env = process.env, spawn = spawnSync } = {}) {
  if (!idPattern.test(record.id)) throw new Error('Invalid schema change id.');
  const content = JSON.stringify({ format: 1, ...record }, null, 2) + '\n';
  writeDurably(join(changesDirectory(root), `${record.id}.json`), content, { env, spawn });
  return record;
}

export function markUndone(root, id, details, { env = process.env, spawn = spawnSync } = {}) {
  if (!idPattern.test(id)) throw new Error('Invalid schema change id.');
  const content = JSON.stringify({ format: 1, id, undoneAt: new Date().toISOString(), ...details }, null, 2) + '\n';
  writeDurably(join(changesDirectory(root), `${id}.undone.json`), content, { env, spawn });
}

// Applied (not yet undone) changes for this exact target, newest first.
export function listChanges(root, config) {
  const directory = changesDirectory(root);
  const names = readdirSync(directory);
  const identity = JSON.stringify(targetIdentity(config));
  return names.filter(name => idPattern.test(name.slice(0, -5)) && name.endsWith('.json') && !name.endsWith('.undone.json'))
    .filter(name => !names.includes(`${name.slice(0, -5)}.undone.json`))
    .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')))
    .filter(record => record.format === 1 && record.mode !== 'reviewed' && JSON.stringify(record.target) === identity)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}
