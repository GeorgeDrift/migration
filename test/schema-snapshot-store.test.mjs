import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { snapshotStore, sealSnapshot, validateSnapshot } from '../schema-snapshot-store.mjs';
import { loadSchemaSnapshot } from '../schema-rollback.mjs';

const target = { host: 'fixture', port: 3306, schema: 'target' };
const record = tables => sealSnapshot({ format: 2, version: '20260101', target, tables, createdAt: 'fixture-time' });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fabla-metadata-'));
  t.after(() => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  });
  const env = { MIGRATION_RECOVERY_S3_URI: 's3://approved-fixture/private/test' };
  const objects = new Map();
  const calls = [];
  const spawn = (binary, args, options) => {
    calls.push(args);
    assert.equal(options.shell, false);
    const key = args[args.indexOf('--key') + 1];
    if (args[1] === 'get-object') {
      if (!objects.has(key)) return { status: 1, stderr: 'An error occurred (NoSuchKey)' };
      writeFileSync(args.at(-1), objects.get(key));
    } else if (args[1] === 'put-object') {
      assert.equal(args[args.indexOf('--if-none-match') + 1], '*');
      assert.equal(args[args.indexOf('--server-side-encryption') + 1], 'AES256');
      if (objects.has(key)) return { status: 1, stderr: '(PreconditionFailed)' };
      objects.set(key, readFileSync(args[args.indexOf('--body') + 1], 'utf8'));
    } else throw new Error('Unexpected command');
    return { status: 0, stdout: '{}' };
  };
  return { root, env, spawn, objects, calls };
}

test('schema evidence is uploaded, downloaded and hash-verified, then recovered after local reset', t => {
  const f = fixture(t);
  const store = snapshotStore(f.root, '20260101', target, f);
  assert.deepEqual(store.save(record({ a: { engine: 'InnoDB' } })), record({ a: { engine: 'InnoDB' } }));
  assert.deepEqual(readdirSync(f.root), []);
  assert.deepEqual(loadSchemaSnapshot(f.root, '20260101', target, f), record({ a: { engine: 'InnoDB' } }));
  assert.equal(f.calls.filter(args => args[1] === 'put-object').length, 1);
  assert.throws(() => store.save(record({ changed: {} })), /do not overwrite/);
});

test('corruption, wrong targets and denied access block writes without exposing stderr', t => {
  const f = fixture(t);
  const store = snapshotStore(f.root, '20260101', target, f);
  store.save(record({}));
  const key = [...f.objects.keys()][0];
  f.objects.set(key, JSON.stringify({ ...record({}), tables: { corrupted: {} } }));
  assert.throws(() => store.read(), /invalid/);
  assert.throws(() => validateSnapshot(record({}), '20260101', { ...target, host: 'wrong' }), /different target/);
  const denied = snapshotStore(f.root, '20260101', target, { env: f.env,
    spawn: () => ({ status: 1, stderr: '(AccessDenied) secret-value' }) });
  assert.throws(() => denied.save(record({})), error => /download failed/.test(error.message) && !error.message.includes('secret-value'));
  assert.deepEqual(readdirSync(f.root), []);
});

test('upload failure and corrupt read-back never report a durable success', t => {
  const f = fixture(t);
  const failure = snapshotStore(f.root, '20260101', target, { env: f.env, spawn: (binary, args, options) =>
    args[1] === 'put-object' ? { status: 1, stderr: '(AccessDenied)' } : f.spawn(binary, args, options) });
  assert.throws(() => failure.save(record({})), /upload failed/);
  const corrupt = snapshotStore(f.root, '20260101', target, { env: f.env, spawn: (binary, args, options) => {
    const result = f.spawn(binary, args, options);
    if (args[1] === 'put-object') f.objects.set([...f.objects.keys()][0], '{}');
    return result;
  } });
  assert.throws(() => corrupt.save(record({})), /invalid/);
  assert.deepEqual(readdirSync(f.root), []);
});
