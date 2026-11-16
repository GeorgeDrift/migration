import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSchemas, sameValue, quoteIdentifier, reconcileBatch, orderTables, connect } from '../copy-data.mjs';
import { floatColumns, selectColumnList, selectRowList } from '../schema-metadata.mjs';

const tables = [{ TABLE_NAME: 'orders', ENGINE: 'InnoDB' }];
const columns = [{ TABLE_NAME: 'orders', COLUMN_NAME: 'id', COLUMN_TYPE: 'bigint(20)' }];

test('copy requires matching application tables and columns', () => {
  assert.doesNotThrow(() => compareSchemas(tables, tables, columns, columns));
  assert.throws(() => compareSchemas(tables, [], columns, []), /table lists differ/);
  assert.throws(() => compareSchemas(tables, tables, columns, []), /columns differ/);
  assert.throws(() => compareSchemas([{ TABLE_NAME: 'orders', ENGINE: 'MyISAM' }], tables, columns, columns), /InnoDB/);
});

test('copy preflight has no seven-table limit', () => {
  const manyTables = Array.from({ length: 50 }, (_, index) => ({ TABLE_NAME: `table_${index}`, ENGINE: 'InnoDB' }));
  const manyColumns = manyTables.map(row => ({ TABLE_NAME: row.TABLE_NAME, COLUMN_NAME: 'id', COLUMN_TYPE: 'bigint(20)' }));
  assert.doesNotThrow(() => compareSchemas(manyTables, manyTables, manyColumns, manyColumns));
});

test('copy compares binary and date values without string coercion', () => {
  assert.equal(sameValue(Buffer.from([0, 255]), Buffer.from([0, 255])), true);
  assert.equal(sameValue(Buffer.from([0]), Buffer.from([1])), false);
  assert.equal(sameValue(new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z')), true);
  assert.equal(sameValue('1', 1), false);
  assert.equal(quoteIdentifier('a`b'), '`a``b`');
});

test('resume verifies existing rows and inserts only missing primary keys', async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    assert.match(sql, /^SELECT /);
    calls.push({ sql, values });
    return [[{ id: 1, name: 'kept' }]];
  }, execute: async (sql, values) => {
    calls.push({ sql, values });
    return [{ affectedRows: 1 }];
  } };
  const inserted = await reconcileBatch(db, 'items', ['id', 'name'], ['id'], [
    { id: 1, name: 'kept' }, { id: 2, name: 'new' },
  ]);
  assert.deepEqual(inserted, { missing: 1, identical: 1 });
  assert.match(calls[1].sql, /INSERT INTO `items`/);
  assert.deepEqual(calls[1].values, [2, 'new']);
});

test('tables are copied parent-first and cycles are rejected', () => {
  const definition = keys => ({ engine: 'InnoDB', identityKey: ['id'], keys });
  const metadata = new Map([
    ['child', definition([{ REFERENCED_TABLE_NAME: 'parent' }])],
    ['parent', definition([])],
  ]);
  assert.deepEqual(orderTables(metadata), ['parent', 'child']);
  metadata.get('parent').keys.push({ REFERENCED_TABLE_NAME: 'child' });
  assert.throws(() => orderTables(metadata), /cycle/);
});

test('resume stops instead of overwriting a conflicting row', async () => {
  const db = { query: async () => [[{ id: 1, name: 'target value' }]] };
  await assert.rejects(
    reconcileBatch(db, 'items', ['id', 'name'], ['id'], [{ id: 1, name: 'source value' }]),
    /differs from source/,
  );
});

test('all-record connections retain original JSON text, TLS and large integers', () => {
  let options;
  const connection = {};
  const result = connect({ host: 'fixture', port: 3306, schema: 'target', user: 'operator' },
    Buffer.from('fixture-ca'), config => {
      options = config;
      return { promise: () => connection };
    });
  assert.equal(result, connection);
  assert.equal(options.jsonStrings, true);
  assert.equal(options.dateStrings, true);
  assert.equal(options.supportBigNumbers, true);
  assert.equal(options.bigNumberStrings, true);
  assert.equal(options.ssl.rejectUnauthorized, true);
});

test('JSON documents are bound unchanged with prepared inserts and remain resumable', async () => {
  const documents = [
    '{ "value": 9007199254740993, "duplicate": 1, "duplicate": 2 }',
    '["first", "second"]',
    '"quoted text"', 'true', 'false', 'null', '123',
    JSON.stringify({ text: 'quote\' and backslash\\ and newline\n' }),
    '[]', '{}', null,
  ];
  const inserted = [];
  const db = {
    async query(sql) {
      assert.match(sql, /^SELECT /);
      return [inserted];
    },
    async execute(sql, values) {
      assert.match(sql, /^INSERT INTO `experiment`/);
      assert.match(sql, /VALUES \(\?, \?\)/);
      for (let index = 0; index < values.length; index += 2) {
        if (values[index + 1] !== null) assert.doesNotThrow(() => JSON.parse(values[index + 1]));
        inserted.push({ experiment_id: values[index], experiment_variables: values[index + 1] });
      }
      return [{ affectedRows: values.length / 2 }];
    },
  };
  const rows = documents.map((document, index) => ({
    experiment_id: index + 1, experiment_variables: document,
  }));
  const args = [db, 'experiment', ['experiment_id', 'experiment_variables'], ['experiment_id'], rows];
  assert.deepEqual(await reconcileBatch(...args), { missing: rows.length, identical: 0 });
  assert.deepEqual(inserted.map(row => row.experiment_variables), documents);
  assert.deepEqual(await reconcileBatch(...args), { missing: 0, identical: rows.length });
  assert.equal(inserted.length, rows.length);
});

test('JSON preview performs no inserts and does not modify source values', async () => {
  const row = Object.freeze({ id: 1, payload: '["original"]' });
  const db = {
    async query(sql) { assert.match(sql, /^SELECT /); return [[]]; },
    execute() { throw new Error('Preview must not write'); },
  };
  assert.deepEqual(await reconcileBatch(db, 'items', ['id', 'payload'], ['id'], [row],
    { execute: false }), { missing: 1, identical: 0 });
  assert.equal(row.payload, '["original"]');
});

test('constraint rejection is propagated without rewriting values or disabling checks', async () => {
  const db = {
    async query(sql) { assert.match(sql, /^SELECT /); return [[]]; },
    async execute(sql, values) {
      assert.match(sql, /^INSERT INTO /);
      assert.equal(values[1], 'invalid document');
      throw new Error('JSON constraint failed');
    },
  };
  await assert.rejects(reconcileBatch(db, 'items', ['id', 'payload'], ['id'],
    [{ id: 1, payload: 'invalid document' }]), /JSON constraint failed/);
});

test('FLOAT columns are read exactly by widening to DOUBLE; other numeric types keep their exact text', async () => {
  const definition = { columns: [
    { COLUMN_NAME: 'id', COLUMN_TYPE: 'bigint(20) unsigned' },
    { COLUMN_NAME: 'ratio', COLUMN_TYPE: 'float' },
    { COLUMN_NAME: 'scaled', COLUMN_TYPE: 'float(7,4) unsigned' },
    { COLUMN_NAME: 'precise', COLUMN_TYPE: 'double' },
    { COLUMN_NAME: 'money', COLUMN_TYPE: 'decimal(20,2)' },
    { COLUMN_NAME: 'odd`name', COLUMN_TYPE: 'FLOAT' },
  ] };
  assert.deepEqual(floatColumns(definition), ['ratio', 'scaled', 'odd`name']);
  assert.equal(selectRowList(definition), '`id`, (`ratio` + 0e0) AS `ratio`, (`scaled` + 0e0) AS `scaled`, '
    + '`precise`, `money`, (`odd``name` + 0e0) AS `odd``name`');
  assert.equal(selectColumnList(['id', 'money']), '`id`, `money`');

  const statements = [];
  const db = {
    async query(sql, values) { statements.push(sql); return [[{ id: '1', ratio: 1.0000001192092896 }]]; },
    async execute() { throw new Error('An identical row must not be written.'); },
  };
  const result = await reconcileBatch(db, 'items', ['id', 'ratio'], ['id'],
    [{ id: '1', ratio: 1.0000001192092896 }], { floats: ['ratio'] });
  assert.deepEqual(result, { missing: 0, identical: 1 });
  assert.match(statements[0], /SELECT `id`, \(`ratio` \+ 0e0\) AS `ratio`/);
  // A FLOAT that only differs beyond six significant digits is still a conflict, never silently equal.
  await assert.rejects(reconcileBatch(db, 'items', ['id', 'ratio'], ['id'], [{ id: '1', ratio: 1 }], { floats: ['ratio'] }),
    /refusing to overwrite/);
});
