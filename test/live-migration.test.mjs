import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { inspectSchemaStage } from '../schema-stage.mjs';
import { applySchemaChange, generateSchemaChange } from '../live-migrate.mjs';
import { listChanges, markUndone, newChangeId, saveChange } from '../schema-changes.mjs';
import { readSchemaState } from '../schema-rollback.mjs';
import { parseRollbackArgs, schemaDown } from '../rollback.mjs';

const databases = {
  dev: { host: 'test-host', port: 3306, schema: 'migration_dev', user: 'admin', passwordKey: 'DEV_DB_PASSWORD' },
  target: { host: 'test-host', port: 3306, schema: 'migration_target', user: 'admin', passwordKey: 'TARGET_DB_PASSWORD' },
};
const identity = config => ({ host: config.host, port: config.port, schema: config.schema });

function temporary(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test cleanup path.');
    rmSync(absolute, { recursive: true, force: true });
  });
  return root;
}

// A tiny live database: tables are column lists, and ADD/DROP column DDL changes them.
function fakeDatabase(tables, { failOn } = {}) {
  const state = { tables: structuredClone(tables), ddl: [] };
  const db = {
    state,
    async execute(sql) {
      if (sql.includes("TABLE_TYPE = 'BASE TABLE'")) return [Object.keys(state.tables).sort().map(TABLE_NAME => ({ TABLE_NAME }))];
      throw new Error(`Unexpected execute: ${sql}`);
    },
    async query(sql, values = []) {
      if (sql.includes('information_schema.TABLES')) {
        return [Object.keys(state.tables).filter(name => values.includes(name)).sort()
          .map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_general_ci' }))];
      }
      if (sql.includes('information_schema.COLUMNS')) {
        return [Object.entries(state.tables).filter(([name]) => values.includes(name)).flatMap(([TABLE_NAME, columns]) =>
          columns.map((COLUMN_NAME, index) => ({ TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION: index + 1,
            COLUMN_TYPE: 'int(11)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, EXTRA: '', COLLATION_NAME: null, GENERATION_EXPRESSION: null })))];
      }
      if (sql.includes('information_schema.')) return [[]];
      state.ddl.push(sql);
      if (failOn && sql === failOn) throw new Error('Lost connection to server');
      const add = sql.match(/^ALTER TABLE `?(\w+)`? ADD (?:COLUMN )?`?(\w+)`?/i);
      const drop = sql.match(/^ALTER TABLE `?(\w+)`? DROP (?:COLUMN )?`?(\w+)`?/i);
      if (add) state.tables[add[1]].push(add[2]);
      else if (drop) state.tables[drop[1]] = state.tables[drop[1]].filter(column => column !== drop[2]);
      return [{}];
    },
    async end() { state.ended = true; },
  };
  return db;
}

test('migration is decided only by comparing the two live databases', async () => {
  const source = fakeDatabase({ study: ['id', 'x'], team: ['id'] });
  const same = await inspectSchemaStage(source, fakeDatabase({ study: ['id', 'x'], team: ['id'] }), databases);
  assert.equal(same.status, 'ready');
  const changed = await inspectSchemaStage(source, fakeDatabase({ study: ['id'], team: ['id'] }), databases);
  assert.equal(changed.status, 'different');
  assert.deepEqual(changed.differences, ['study']);
  const empty = await inspectSchemaStage(source, fakeDatabase({}), databases);
  assert.deepEqual([empty.status, empty.targetTables, empty.differences], ['different', 0, ['study', 'team']]);
  await assert.rejects(inspectSchemaStage(fakeDatabase({}), source, databases), /Source has no application tables/);
});

test('schema SQL and its reverse are generated from the live databases', () => {
  const calls = [];
  const spawn = (binary, args, options) => {
    calls.push(args.slice(1));
    assert.equal(options.shell, false);
    return { status: 0, stdout: args.includes('--reverse') ? 'ALTER TABLE `study` DROP COLUMN `x`;' : 'ALTER TABLE `study` ADD COLUMN `x` int NULL;' };
  };
  const change = generateSchemaChange({ spawn });
  assert.deepEqual(calls, [[], ['--reverse']]);
  assert.deepEqual(change.statements, ['ALTER TABLE `study` ADD COLUMN `x` int NULL']);
  assert.deepEqual(change.reverseStatements, ['ALTER TABLE `study` DROP COLUMN `x`']);
  assert.match(change.sha256, /^[0-9a-f]{64}$/);

  const noReverse = generateSchemaChange({ spawn: (binary, args) => (args.includes('--reverse') ? { status: 1 } : { status: 0, stdout: 'ALTER TABLE t ADD y int;' }) });
  assert.equal(noReverse.reverseSql, undefined);
  assert.throws(() => generateSchemaChange({ spawn: () => ({ status: 0, stdout: '' }) }), /no SQL could be generated/);
  assert.throws(() => generateSchemaChange({ spawn: () => ({ status: 1, stderr: '' }) }), /could not be generated/);
});

test('applying a change runs each statement under the lock check and returns the schema before and after', async () => {
  const db = fakeDatabase({ study: ['id'] });
  let checks = 0;
  const states = await applySchemaChange(db, 'migration_target',
    { statements: ['ALTER TABLE study ADD x', 'ALTER TABLE study ADD y'] }, { assertSafe: async () => { checks++; } });
  assert.equal(checks, 2);
  assert.deepEqual(Object.keys(states.before.study.columns).length, 1);
  assert.deepEqual(states.after.study.columns.map(column => column.COLUMN_NAME), ['id', 'x', 'y']);
  await assert.rejects(applySchemaChange(fakeDatabase({ study: ['id'] }), 'migration_target',
    { statements: ['ANALYZE TABLE study'] }, { assertSafe: async () => {} }), /changed nothing/);
});

// S3 is modelled as a directory so records really round-trip.
function fakeS3(t) {
  const bucket = temporary(t, 'fabla-s3-');
  const local = uri => join(bucket, uri.replace(/^s3:\/\//, ''));
  const calls = [];
  const spawn = (binary, args, options) => {
    calls.push(args.join(' '));
    assert.equal(options.shell, false);
    const [, action, from, to] = args;
    assert.equal(action, 'cp');
    if (from.startsWith('s3://')) {
      if (!existsSync(local(from))) return { status: 1 };
      cpSync(local(from), to);
    } else {
      mkdirSync(dirname(local(to)), { recursive: true });
      cpSync(from, local(to));
    }
    return { status: 0 };
  };
  return { spawn, calls, local };
}

const env = { MIGRATION_RECOVERY_S3_URI: 's3://private-test-bucket/george-migration/migration_target' };
function record(overrides = {}) {
  return {
    id: newChangeId(Date.parse('2026-10-05T10:00:00Z')), createdAt: '2026-10-05T10:00:00.000Z',
    target: identity(databases.target), source: identity(databases.dev), checkpoint: '1791147653833-checkpoint',
    sha256: 'a'.repeat(64), sql: 'ALTER TABLE study ADD x;\n', reverseSql: 'ALTER TABLE study DROP x;\n',
    schemaBefore: {}, schemaAfter: {}, ...overrides,
  };
}

test('change records are kept locally and verified in S3, listed newest first for the right target only', async t => {
  const root = temporary(t, 'fabla-records-');
  const s3 = fakeS3(t);
  const older = record({ id: newChangeId(1791140000000 + 1000), createdAt: '2026-10-05T09:00:00.000Z' });
  const newer = record({ id: newChangeId(1791140000000 + 2000), createdAt: '2026-10-05T11:00:00.000Z' });
  const elsewhere = record({ id: newChangeId(1791140000000 + 3000), target: { ...identity(databases.target), schema: 'other_target' } });
  for (const item of [older, newer, elsewhere]) saveChange(root, item, { env, spawn: s3.spawn });
  assert.ok(s3.calls.some(call => call.includes('--sse AES256')));
  assert.ok(existsSync(s3.local(`${env.MIGRATION_RECOVERY_S3_URI}/schema-changes/${newer.id}.json`)));
  assert.deepEqual(listChanges(root, databases.target).map(item => item.id), [newer.id, older.id]);
  markUndone(root, newer.id, { checkpoint: 'x' }, { env, spawn: s3.spawn });
  assert.deepEqual(listChanges(root, databases.target).map(item => item.id), [older.id]);

  assert.throws(() => saveChange(root, record({ id: newChangeId(1791140000000 + 4000) }), { env: {}, spawn: s3.spawn }), /MIGRATION_RECOVERY_S3_URI/);
  assert.throws(() => saveChange(root, record({ id: newChangeId(1791140000000 + 5000) }), { env, spawn: () => ({ status: 0 }) }), /could not be verified/);
  assert.throws(() => saveChange(root, record({ id: '../escape' }), { env, spawn: s3.spawn }), /Invalid schema change id/);
});

async function undoFixture(t, { tables = { study: ['id', 'x'] }, failOn, records } = {}) {
  const root = temporary(t, 'fabla-undo-');
  const s3 = fakeS3(t);
  const ca = join(temporary(t, 'fabla-ca-'), 'ca.pem');
  writeFileSync(ca, 'test-ca');
  const db = fakeDatabase(tables, { failOn });
  const before = await readSchemaState(fakeDatabase({ study: ['id'] }), 'migration_target');
  const after = await readSchemaState(fakeDatabase({ study: ['id', 'x'] }), 'migration_target');
  const saved = (records ?? [record({ schemaBefore: before, schemaAfter: after })]).map(item => saveChange(root, item, { env, spawn: s3.spawn }));
  const events = [];
  const deps = {
    env: { ...env, TARGET_DB_PASSWORD: 'secret', RDS_CA_BUNDLE: ca, MIGRATION_RECOVERY_DIR: root },
    connect: async () => db, spawn: s3.spawn, print: () => {},
    open: async () => ({
      async checkpoint(label) { events.push(`checkpoint: ${label}`); return { id: 'undo-checkpoint' }; },
      async assertSafe() { events.push('assertSafe'); },
      async restore(checkpoint) { events.push(`restore ${checkpoint.id}`); return checkpoint; },
      async close() { events.push('close'); },
    }),
  };
  return { root, db, deps, events, saved, before, after };
}

const execute = { action: 'down', steps: 1, execute: true, confirmTarget: 'migration_target', confirmHost: 'test-host' };

test('rollback down arguments are explicit and confirmation is mandatory for writes', () => {
  assert.deepEqual(parseRollbackArgs(['down']), { action: 'down', steps: 1, execute: false });
  assert.equal(parseRollbackArgs(['down', '--steps', '12']).steps, 12);
  assert.throws(() => parseRollbackArgs(['down', '--steps', '0']), /positive integer/);
  assert.throws(() => parseRollbackArgs(['down', '--execute']), /confirmation/);
  assert.equal(parseRollbackArgs(['down', '--allow-destructive']).allowDestructive, true);
  assert.throws(() => parseRollbackArgs(['down', '--allow-destructive', '--allow-destructive']), /Repeated/);
  assert.throws(() => parseRollbackArgs(['restore', '--steps', '4']), /1, 2, or 3/);
});

test('undo previews the recorded reverse SQL without writing', async t => {
  const fixture = await undoFixture(t);
  const preview = await schemaDown({ action: 'down', steps: 1, execute: false }, databases, fixture.deps);
  assert.equal(preview.executed, false);
  assert.equal(preview.changes[0].sql, 'ALTER TABLE study DROP x;\n');
  assert.deepEqual(fixture.db.state.ddl, []);
  assert.deepEqual(fixture.events, []);
});

test('undo saves a checkpoint, reverses the change, verifies the schema before it and marks it undone', async t => {
  const fixture = await undoFixture(t);
  const result = await schemaDown(execute, databases, fixture.deps);
  assert.deepEqual(result.undone, [fixture.saved[0].id]);
  assert.equal(result.checkpoint, 'undo-checkpoint');
  assert.match(fixture.events[0], /^checkpoint: Before undoing schema change/);
  assert.deepEqual(fixture.db.state.ddl, ['ALTER TABLE study DROP x']);
  assert.deepEqual(fixture.db.state.tables.study, ['id']);
  assert.deepEqual(listChanges(fixture.root, databases.target), []);
  assert.equal(fixture.events.at(-1), 'close');
});

test('undo refuses when the target changed after the recorded change, before any checkpoint', async t => {
  const fixture = await undoFixture(t, { tables: { study: ['id', 'x', 'later'] } });
  await assert.rejects(schemaDown(execute, databases, fixture.deps), /changed after schema change .* restore a checkpoint instead/);
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.db.state.ddl, []);
});

test('a failed undo restores the checkpoint taken before it and keeps the record', async t => {
  const fixture = await undoFixture(t, { failOn: 'ALTER TABLE study DROP x' });
  await assert.rejects(schemaDown(execute, databases, fixture.deps), /Lost connection.*restored to checkpoint undo-checkpoint/);
  assert.ok(fixture.events.includes('restore undo-checkpoint'));
  assert.equal(listChanges(fixture.root, databases.target).length, 1);
});

test('undo explains missing records, missing reverse SQL and wrong confirmation', async t => {
  const empty = await undoFixture(t, { records: [] });
  await assert.rejects(schemaDown(execute, databases, empty.deps), /No recorded schema changes/);
  const noReverse = await undoFixture(t, { records: [record({ reverseSql: undefined })] });
  await assert.rejects(schemaDown(execute, databases, noReverse.deps), /no reverse SQL.*1791147653833-checkpoint/);
  const one = await undoFixture(t);
  await assert.rejects(schemaDown({ ...execute, steps: 2 }, databases, one.deps), /Only 1 recorded schema change/);
  await assert.rejects(schemaDown({ ...execute, confirmHost: 'other' }, databases, one.deps), /does not match/);
});

test('undoing two changes reverses the newest first and checks each step', async t => {
  const states = await Promise.all([['id'], ['id', 'x'], ['id', 'x', 'y']].map(columns =>
    readSchemaState(fakeDatabase({ study: columns }), 'migration_target')));
  const first = record({ id: newChangeId(1791140000000 + 1000), createdAt: '2026-10-05T09:00:00.000Z', schemaBefore: states[0], schemaAfter: states[1] });
  const second = record({ id: newChangeId(1791140000000 + 2000), createdAt: '2026-10-05T10:00:00.000Z', reverseSql: 'ALTER TABLE study DROP y;\n',
    schemaBefore: states[1], schemaAfter: states[2] });
  const fixture = await undoFixture(t, { tables: { study: ['id', 'x', 'y'] }, records: [first, second] });
  const result = await schemaDown({ ...execute, steps: 2 }, databases, fixture.deps);
  assert.deepEqual(result.undone, [second.id, first.id]);
  assert.deepEqual(fixture.db.state.ddl, ['ALTER TABLE study DROP y', 'ALTER TABLE study DROP x']);
});
