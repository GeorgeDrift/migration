import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { loadMigrations, pendingMigrations, readDownSql } from '../migration-policy.mjs';
import { generatedSchema } from '../integration/generated-schema.mjs';
import {
  applySchemaRollback, compareSchemaState, planSchemaRollback, snapshotPath, undoMarker, undoProgress,
} from '../schema-rollback.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const databases = {
  dev: { host: 'test-host', port: 3306, schema: 'migration_dev', user: 'admin', passwordKey: 'DEV_DB_PASSWORD' },
  target: { host: 'test-host', port: 3306, schema: 'migration_target', user: 'admin', passwordKey: 'TARGET_DB_PASSWORD' },
};
const files = {
  '202601010001_base.sql': { up: 'CREATE TABLE a (id int PRIMARY KEY);\n', down: 'DROP TABLE a;\n', downRisk: 'destructive' },
  '202601010002_change.sql': {
    up: 'ALTER TABLE a ADD b int;\nALTER TABLE a ADD c int;\nCREATE INDEX a_b ON a (b);\n',
    down: '-- reverse of change\nDROP INDEX a_b ON a;\nALTER TABLE a DROP c;\nALTER TABLE a DROP b;\n',
    downRisk: 'destructive',
  },
  '202601010003_index.sql': { up: 'CREATE INDEX a_id ON a (id);\n', down: 'DROP INDEX a_id ON a;\n', downRisk: 'additive' },
};

function temporary(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test cleanup path.');
    rmSync(absolute, { recursive: true, force: true });
  });
  return root;
}

function migrationRoot(t, selected = files) {
  const root = temporary(t, 'fabla-down-');
  mkdirSync(join(root, 'migrations'));
  mkdirSync(join(root, 'down-migrations'));
  const policy = {};
  for (const [name, file] of Object.entries(selected)) {
    writeFileSync(join(root, 'migrations', name), file.up);
    policy[name] = { sha256: digest(file.up), scope: 'schema', risk: file.risk || 'additive' };
    if (file.down) {
      writeFileSync(join(root, 'down-migrations', name), file.down);
      policy[name].down = { sha256: digest(file.down), risk: file.downRisk };
    }
  }
  writeFileSync(join(root, 'migration-policy.json'), JSON.stringify(policy, null, 2));
  return root;
}

const done = version => ({ version, applied: 1, total: 1, error: null });

function fakeTarget(revisions, { failAt, lockTaken = false } = {}) {
  const state = { revisions: revisions.map(row => ({ ...row })), ddl: [], markers: [], locks: [], ended: false };
  const db = {
    async execute(sql, params = []) {
      if (sql.includes("TABLE_NAME = 'atlas_schema_revisions'")) return [[{ 1: 1 }]];
      if (sql.includes("TABLE_TYPE = 'BASE TABLE'")) return [[]];
      if (sql.startsWith('SELECT GET_LOCK')) { state.locks.push(['get', params[0]]); return [[{ acquired: lockTaken ? 0 : 1, owner: 17 }]]; }
      if (sql.startsWith('SELECT IS_USED_LOCK')) return [[{ owner: 17 }]];
      if (sql.startsWith('SELECT RELEASE_LOCK')) { state.locks.push(['release', params[0]]); return [[{}]]; }
      if (sql.startsWith('UPDATE atlas_schema_revisions')) {
        state.markers.push(params[0]);
        state.revisions.find(row => row.version === params[1]).error = params[0];
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('DELETE FROM atlas_schema_revisions')) {
        const before = state.revisions.length;
        state.revisions = state.revisions.filter(row => row.version !== params[0]);
        return [{ affectedRows: before - state.revisions.length }];
      }
      throw new Error(`Unexpected execute: ${sql}`);
    },
    async query(sql) {
      if (sql.startsWith('SELECT version')) return [state.revisions.map(row => ({ ...row }))];
      if (failAt !== undefined && state.ddl.length === failAt) { failAt = undefined; throw new Error('Lost connection'); }
      state.ddl.push(sql);
      return [{}];
    },
    async end() { state.ended = true; },
  };
  const open = async () => {
    if (lockTaken) throw new Error('Another migration or restore owns the target lock.');
    state.locks.push(['get', 'mock-recovery']);
    return {
      async assertSafe() {},
      async checkpoint() { this.last = { id: 'test-checkpoint', durable: true }; },
      async close() { state.locks.push(['release', 'mock-recovery']); },
    };
  };
  return { db, state, connect: async () => db, open };
}

function environment(t, settings = {}) {
  const ca = join(temporary(t, 'fabla-ca-'), 'ca.pem');
  writeFileSync(ca, 'test-ca');
  return { TARGET_DB_PASSWORD: 'private-password', RDS_CA_BUNDLE: ca,
    MIGRATION_RECOVERY_DIR: temporary(t, 'fabla-snapshots-'),
    MIGRATION_MAINTENANCE_TARGET: 'migration_target', ...settings };
}

const execute = { action: 'down', steps: 1, execute: true, allowDestructive: true, checkpoint: false,
  confirmTarget: 'migration_target', confirmHost: 'test-host' };

test('reverse SQL is hash-locked alongside its forward migration', t => {
  const root = migrationRoot(t);
  const migrations = loadMigrations({ root });
  assert.deepEqual(migrations[1].down, { sha256: digest(files['202601010002_change.sql'].down), risk: 'destructive' });
  assert.equal(readDownSql(migrations[1], { root }), files['202601010002_change.sql'].down);

  writeFileSync(join(root, 'down-migrations', '202601010002_change.sql'), 'DROP TABLE a;\n');
  assert.throws(() => loadMigrations({ root }), /Reverse SQL for 202601010002_change.sql is missing, unreviewed or changed/);

  const orphan = migrationRoot(t, { '202601010001_base.sql': { up: 'CREATE TABLE a (id int);\n' } });
  writeFileSync(join(orphan, 'down-migrations', '202601010001_base.sql'), 'DROP TABLE a;\n');
  assert.throws(() => loadMigrations({ root: orphan }), /unreviewed or has no forward migration/);
});

test('undo plans run newest first and refuse missing, partial or out-of-order history', t => {
  const root = migrationRoot(t);
  const migrations = loadMigrations({ root });
  const readSql = migration => readDownSql(migration, { root });
  const revisions = Object.keys(files).map(name => done(name.split('_')[0]));
  const plan = planSchemaRollback(migrations, revisions, 2, { readSql });
  assert.deepEqual(plan.migrations.map(item => item.name), ['202601010003_index.sql', '202601010002_change.sql']);
  assert.equal(plan.oldestVersion, '202601010002');
  assert.equal(plan.requiresAllowDestructive, true);
  assert.deepEqual(plan.migrations[1].statements, ['DROP INDEX a_b ON a', 'ALTER TABLE a DROP c', 'ALTER TABLE a DROP b']);
  assert.equal(planSchemaRollback(migrations, revisions, 1, { readSql }).requiresAllowDestructive, false);

  assert.throws(() => planSchemaRollback(migrations, revisions, 4, { readSql }), /Only 3 applied/);
  assert.throws(() => planSchemaRollback(migrations, [], 1, { readSql }), /nothing to undo/);
  assert.throws(() => planSchemaRollback(migrations, [done('202601010002')], 1, { readSql }), /out of order/);
  assert.throws(() => planSchemaRollback(migrations, [done('202601010001'), { version: '202601010002', applied: 1, total: 3, error: 'x' }], 1, { readSql }), /partially applied/);
  assert.throws(() => planSchemaRollback(migrations, [...revisions, done('999')], 1, { readSql }), /unknown or duplicate/);

  const noReverse = migrationRoot(t, { '202601010001_base.sql': { up: 'CREATE TABLE a (id int);\n' } });
  const plain = loadMigrations({ root: noReverse });
  assert.throws(() => planSchemaRollback(plain, [done('202601010001')], 1, { readSql }), /No reviewed reverse SQL for 202601010001_base.sql.*rollback -- restore/);
});

test('a destructive forward migration requires explicit approval even with additive reverse SQL', t => {
  const root = migrationRoot(t, { '202601010001_drop.sql': { up: 'ALTER TABLE a DROP x;\n', risk: 'destructive',
    down: 'ALTER TABLE a ADD x int;\n', downRisk: 'additive' } });
  const plan = planSchemaRollback(loadMigrations({ root }), [done('202601010001')], 1,
    { readSql: migration => readDownSql(migration, { root }) });
  assert.equal(plan.requiresAllowDestructive, true);
});

test('uncertain DDL outcomes block replay; only acknowledged progress can resume', async t => {
  const root = migrationRoot(t);
  const migrations = loadMigrations({ root });
  const readSql = migration => readDownSql(migration, { root });
  const revisions = [done('202601010001'), done('202601010002')];
  const target = fakeTarget(revisions, { failAt: 1 });
  const plan = planSchemaRollback(migrations, revisions, 1, { readSql });
  await assert.rejects(applySchemaRollback(target.db, plan, { print: () => {} }),
    /Reverse statement 2 of 3 for 202601010002_change.sql failed: Lost connection.*uncertain/);
  assert.deepEqual(target.state.ddl, ['DROP INDEX a_b ON a']);
  const stuck = target.state.revisions.find(row => row.version === '202601010002');
  assert.deepEqual(undoProgress(stuck.error), { state: 'started', done: 1, total: 3,
    sqlSha256: digest(files['202601010002_change.sql'].down) });

  // Forward migrations stay blocked until the undo is finished or a checkpoint is restored.
  assert.throws(() => pendingMigrations(migrations, target.state.revisions), /stopped partway.*rollback -- down/);

  assert.throws(() => planSchemaRollback(migrations, target.state.revisions, 1, { readSql }), /Uncertain reverse statement/);
  // A durable completed marker is resumable. An operator must not manufacture it after a crash.
  const acknowledged = fakeTarget([done('202601010001'), { ...done('202601010002'),
    error: undoMarker(1, 3, 'change.sql', 'completed', digest(files['202601010002_change.sql'].down)) }]);
  const resumed = planSchemaRollback(migrations, acknowledged.state.revisions, 1, { readSql });
  assert.equal(resumed.migrations[0].completed, 1);
  const undone = await applySchemaRollback(acknowledged.db, resumed, { print: () => {} });
  assert.deepEqual(undone, ['202601010002_change.sql']);
  assert.deepEqual(acknowledged.state.ddl, ['ALTER TABLE a DROP c', 'ALTER TABLE a DROP b']);
  assert.deepEqual(acknowledged.state.revisions.map(row => row.version), ['202601010001']);
  assert.deepEqual(acknowledged.state.markers.map(undoProgress).map(item => item.done), [1, 2, 2, 3]);
  assert.match(undoMarker(1, 3, 'x.sql'), /^fabla-down:v2:completed:1\/3 /);
});

test('a server commit followed by disconnect must not replay a reverse statement', async t => {
  const root = migrationRoot(t);
  const migrations = loadMigrations({ root });
  const target = fakeTarget([done('202601010001'), done('202601010002')]);
  const original = target.db.query;
  target.db.query = async sql => { await original(sql); throw new Error('Acknowledgement lost after commit'); };
  const readSql = migration => readDownSql(migration, { root });
  const plan = planSchemaRollback(migrations, target.state.revisions, 1, { readSql });
  await assert.rejects(applySchemaRollback(target.db, plan, { print: () => {} }), /uncertain/);
  assert.equal(target.state.ddl.length, 1);
  assert.throws(() => planSchemaRollback(migrations, target.state.revisions, 1, { readSql }), /Do not replay DDL/);
  for (const marker of ['fabla-down:0/3 old marker', undoMarker(4, 3, 'x.sql')]) {
    target.state.revisions[1].error = marker;
    assert.throws(() => planSchemaRollback(migrations, target.state.revisions, 1, { readSql }), /Uncertain|Invalid undo position/);
  }
});

test('verification failure retains completed undo history instead of claiming a clean state', async t => {
  const root = migrationRoot(t);
  const target = fakeTarget([done('202601010001'), done('202601010002')]);
  const plan = planSchemaRollback(loadMigrations({ root }), target.state.revisions, 1,
    { readSql: migration => readDownSql(migration, { root }) });
  await assert.rejects(applySchemaRollback(target.db, plan, { print: () => {},
    verifyMigration: async () => { throw new Error('Schema verification mismatch'); } }), /verification mismatch/);
  assert.deepEqual(undoProgress(target.state.revisions[1].error), { state: 'completed', done: 3, total: 3,
    sqlSha256: digest(files['202601010002_change.sql'].down) });
  assert.equal(target.state.revisions.length, 2);
});

test('snapshot comparison reports every differing table regardless of schema size', () => {
  const count = 300;
  const expected = Object.fromEntries(Array.from({ length: count }, (_, index) => [`t${index}`, { columns: [index] }]));
  const actual = Object.fromEntries(Object.entries(expected).map(([name, value], index) =>
    [name, index % 3 ? value : { columns: [index, 'status'] }]));
  assert.equal(compareSchemaState(expected, actual).length, count / 3);
  assert.deepEqual(compareSchemaState(expected, structuredClone(expected)), []);
});

test('the schema generator rejects empty or unsafe input and scales linearly', () => {
  assert.throws(() => generatedSchema(0), /at least one table/);
  assert.throws(() => generatedSchema(3, 'x; DROP'), /plain identifier/);
  const large = generatedSchema(1000);
  assert.equal(large.tables.length, 1000);
  assert.equal(large.up.split('\n').length, 1000);
  assert.equal(large.down.split('\n').length, 1000);
  assert.equal(new Set(large.tables).size, 1000);
});

test('schema state comparison names changed fields and missing tables', () => {
  assert.deepEqual(compareSchemaState({ a: { engine: 'InnoDB' } }, { a: { engine: 'InnoDB' } }), []);
  assert.deepEqual(compareSchemaState({ a: { engine: 'InnoDB' } }, { a: { engine: 'Aria' }, b: { engine: 'InnoDB' } }),
    [{ table: 'a', fields: ['engine'] }, { table: 'b', fields: ['table'] }]);
});

test('the reviewed baseline reverse SQL drops all twelve baseline tables, children before parents', () => {
  const migrations = loadMigrations();
  const baseline = migrations.find(migration => migration.name === '202610020001_create_target_tables.sql');
  assert.equal(baseline.down.risk, 'destructive');
  const dropped = [...readDownSql(baseline).matchAll(/^DROP TABLE `([^`]+)`;$/gm)].map(match => match[1]);
  const createSql = readFileSync(new URL('../migrations/202610020001_create_target_tables.sql', import.meta.url), 'utf8');
  const created = [...createSql.matchAll(/CREATE TABLE `([^`]+)`/g)].map(match => match[1]);
  assert.deepEqual([...dropped].sort(), [...created].sort());
  for (const block of createSql.split(/(?=-- Create ")/)) {
    const table = block.match(/CREATE TABLE `([^`]+)`/)?.[1];
    if (!table) continue;
    for (const [, parent] of block.matchAll(/REFERENCES `([^`]+)`/g)) {
      if (parent !== table) assert.ok(dropped.indexOf(table) < dropped.indexOf(parent), `${table} must drop before ${parent}`);
    }
  }
});
