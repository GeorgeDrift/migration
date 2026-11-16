import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSchemaMetadata, isGeneratedColumn, readSchemaMetadata } from '../schema-metadata.mjs';

const definition = {
  engine: 'InnoDB',
  collation: 'utf8mb4_unicode_ci',
  columns: [{ COLUMN_NAME: 'id', EXTRA: 'auto_increment' }],
  indexes: [{ INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, COLUMN_NAME: 'id' }],
  keys: [{ CONSTRAINT_NAME: 'PRIMARY', COLUMN_NAME: 'id' }],
  identityKey: ['id'],
};

test('schema comparison requires identical source and target definitions', () => {
  const source = new Map([['experiment', definition]]);
  const target = new Map([['experiment', structuredClone(definition)]]);
  assert.deepEqual(compareSchemaMetadata(source, target, { required: ['experiment'] }),
    ['experiment']);
  target.get('experiment').collation = 'latin1_swedish_ci';
  assert.throws(
    () => compareSchemaMetadata(source, target, { required: ['experiment'] }),
    /definitions differ/,
  );
});

test('schema metadata compares FK actions and CHECK expressions, normalizing only local schema names', async () => {
  const connection = (schema, rule = 'CASCADE', check = '`id` > 0') => ({ query: async sql => {
    if (sql.includes('FROM information_schema.TABLES')) return [[{
      TABLE_NAME: 'child', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_general_ci',
    }]];
    if (sql.includes('FROM information_schema.COLUMNS')) return [[{
      TABLE_NAME: 'child', COLUMN_NAME: 'id', COLUMN_TYPE: 'int(11)', IS_NULLABLE: 'NO',
    }]];
    if (sql.includes('FROM information_schema.STATISTICS')) return [[]];
    if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) {
      assert.match(sql, /JOIN information_schema.REFERENTIAL_CONSTRAINTS/);
      return [[{ TABLE_NAME: 'child', CONSTRAINT_NAME: 'fk', COLUMN_NAME: 'id', ORDINAL_POSITION: 1,
        REFERENCED_TABLE_NAME: 'parent', REFERENCED_COLUMN_NAME: 'id',
        REFERENCED_TABLE_SCHEMA: schema, UPDATE_RULE: 'RESTRICT', DELETE_RULE: rule, MATCH_OPTION: 'NONE' },
      { TABLE_NAME: 'child', CONSTRAINT_NAME: 'PRIMARY', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 }]];
    }
    if (sql.includes('FROM information_schema.CHECK_CONSTRAINTS')) return [[{
      TABLE_NAME: 'child', CONSTRAINT_NAME: 'positive', CHECK_CLAUSE: check,
    }]];
    throw new Error('Unexpected catalog query');
  } });
  const read = (schema, ...args) => readSchemaMetadata(connection(schema, ...args), schema, ['child']);
  const source = await read('dev');
  const target = await read('target');
  assert.deepEqual(source, target);
  assert.equal(source.get('child').keys[0].REFERENCED_TABLE_SCHEMA, '@local');
  assert.throws(() => compareSchemaMetadata(source, new Map([['child', {
    ...target.get('child'), checks: [{ CONSTRAINT_NAME: 'positive', CHECK_CLAUSE: '`id` >= 0' }],
  }]]), { required: ['child'] }), /definitions differ/);
  assert.throws(() => compareSchemaMetadata(source, new Map([['child', {
    ...target.get('child'), keys: [{ ...target.get('child').keys[0], DELETE_RULE: 'RESTRICT' }],
  }]]), { required: ['child'] }), /definitions differ/);
  assert.notDeepEqual(source, await read('target', 'RESTRICT'));
  assert.notDeepEqual(source, await read('target', 'CASCADE', '`id` >= 0'));
});

test('default-generated columns remain writable but computed columns do not', () => {
  assert.equal(isGeneratedColumn({ EXTRA: 'DEFAULT_GENERATED' }), false);
  assert.equal(isGeneratedColumn({ EXTRA: 'STORED GENERATED' }), true);
});
