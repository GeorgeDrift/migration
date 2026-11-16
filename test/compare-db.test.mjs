import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTable, compareTables } from '../compare-db.mjs';

const definition = {
  engine: 'InnoDB', columns: [{ COLUMN_NAME: 'id' }, { COLUMN_NAME: 'value' }],
  identityKey: ['id'], indexes: [], keys: [],
};

test('matching table definitions are reported as identical', () => {
  assert.deepEqual(compareTable('study', definition, structuredClone(definition)), {
    table: 'study', schema: 'identical', fields: [],
  });
});

test('schema drift reports exact fields without accessing records', () => {
  const changed = structuredClone(definition);
  changed.columns[1].COLUMN_DEFAULT = 'different';
  const result = compareTable('study', definition, changed);
  assert.equal(result.schema, 'different');
  assert.deepEqual(result.fields, [{ field: 'columns.1.COLUMN_DEFAULT', source: null, target: 'different' }]);
  assert.deepEqual(Object.keys(result).sort(), ['fields', 'schema', 'table']);
});

test('missing tables are identified on either side', () => {
  assert.equal(compareTable('source_table', definition, undefined).schema, 'source-only');
  assert.equal(compareTable('target_table', undefined, definition).schema, 'target-only');
});

test('all table schemas are compared', () => {
  const changed = { ...definition, engine: 'MyISAM' };
  const source = new Map([['same', definition], ['changed', definition], ['source_only', definition]]);
  const target = new Map([['same', definition], ['changed', changed], ['target_only', definition]]);
  const result = compareTables(['changed', 'same', 'source_only', 'target_only'], source, target);
  assert.deepEqual(result.map(item => item.schema), ['different', 'identical', 'source-only', 'target-only']);
});
