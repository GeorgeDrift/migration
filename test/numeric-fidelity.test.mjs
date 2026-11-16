import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNumericFidelity, numericDefinitions, preserveNumericDefinitions, readNumericSource } from '../numeric-fidelity.mjs';

const create = "CREATE TABLE `study` (\n `study_id` int NOT NULL,\n `diary_incentive` double(10,2) NOT NULL DEFAULT 0.00,\n `bonus_amount` double(10,2) NOT NULL DEFAULT 0.00,\n PRIMARY KEY (`study_id`)\n) ENGINE=InnoDB";
const definitions = new Map([['study', numericDefinitions(create)]]);
const wrong = create.replaceAll('double(10,2)', 'double');
const metadata = type => new Map([['study', { columns: [
  { COLUMN_NAME: 'diary_incentive', COLUMN_TYPE: type },
  { COLUMN_NAME: 'bonus_amount', COLUMN_TYPE: type },
] }]]);

test('new baseline preserves both sized DOUBLE columns and exact source defaults', () => {
  const sql = preserveNumericDefinitions('-- Create study\n' + wrong + ';', definitions, new Map());
  assert.equal((sql.match(/double\(10,2\)/g) || []).length, 2);
  assert.equal((sql.match(/DEFAULT 0.00/g) || []).length, 2);
  assert.match(sql, /PRIMARY KEY/);
  assert.doesNotThrow(() => assertNumericFidelity(sql, definitions));
});

test('an empty Atlas diff still proposes corrections for existing plain DOUBLE', () => {
  const sql = preserveNumericDefinitions('', definitions, metadata('double'));
  assert.match(sql, /ALTER TABLE `study`/);
  assert.match(sql, /MODIFY COLUMN `diary_incentive` double\(10,2\)/);
  assert.match(sql, /MODIFY COLUMN `bonus_amount` double\(10,2\)/);
  assert.doesNotThrow(() => assertNumericFidelity(sql, definitions));
});

test('matching numeric columns do not produce needless corrections', () => {
  assert.equal(preserveNumericDefinitions('', definitions, metadata('double(10,2)')), '');
});

test('preflight rejects an older reviewed baseline that drops numeric precision', () => {
  assert.throws(() => assertNumericFidelity(wrong + ';', definitions), /SQL loses.*study.diary_incentive/);
});

test('preflight rejects lossy MODIFY statements and missing numeric columns', () => {
  assert.throws(() => assertNumericFidelity('ALTER TABLE `study` MODIFY COLUMN `bonus_amount` double NOT NULL DEFAULT 0;', definitions), /SQL loses/);
  assert.throws(() => assertNumericFidelity('CREATE TABLE `study` (`study_id` int);', definitions), /SQL omits/);
});

test('SQL splitting respects quotes, escaped identifiers, commas and semicolons in comments', () => {
  const sql = "CREATE TABLE `strange``table` (`id` int, `price``usd` float(8,3) unsigned NOT NULL DEFAULT 0.000 COMMENT 'a, b; c (d)', `text` varchar(40) DEFAULT 'it''s; fine') ENGINE=InnoDB";
  const source = new Map([['strange`table', numericDefinitions(sql)]]);
  const result = preserveNumericDefinitions('/* preview; comment */\n' + sql.replace('float(8,3)', 'float') + ';', source, new Map());
  assert.match(result, /float\(8,3\) unsigned/);
  assert.match(result, /COMMENT 'a, b; c \(d\)'/);
  assert.doesNotThrow(() => assertNumericFidelity(result, source));
});

test('unrelated table SQL is retained and malformed SQL fails before output', () => {
  const sql = 'CREATE TABLE `team` (`id` int);';
  assert.equal(preserveNumericDefinitions(sql, new Map(), new Map()), sql + '\n');
  assert.throws(() => numericDefinitions("CREATE TABLE `study` (`price` double(10,2) COMMENT 'unterminated)"), /Unterminated/);
});

test('source inspection reads canonical definitions without making writes', async () => {
  const source = await readNumericSource({
    async execute(sql, values) {
      assert.match(sql, /^SELECT DISTINCT TABLE_NAME/);
      assert.deepEqual(values, ['migration_dev']);
      return [[{ TABLE_NAME: 'study' }]];
    },
    async query(sql) {
      assert.equal(sql, 'SHOW CREATE TABLE `migration_dev`.`study`');
      return [[{ 'Create Table': create }]];
    },
  }, 'migration_dev');
  assert.deepEqual(source, definitions);
});

test('lossy Atlas ALTER is rewritten once, preserving column position and other operations', () => {
  const atlas = 'ALTER TABLE `study` MODIFY COLUMN `diary_incentive` double NOT NULL DEFAULT 0 AFTER `study_id`, ADD COLUMN `other` int;';
  const sql = preserveNumericDefinitions(atlas, definitions, metadata('double'));
  assert.match(sql, /double\(10,2\) NOT NULL DEFAULT 0\.00 AFTER `study_id`/);
  assert.match(sql, /ADD COLUMN `other` int/);
  assert.equal((sql.match(/MODIFY COLUMN `diary_incentive`/g) || []).length, 1);
  assert.doesNotThrow(() => assertNumericFidelity(sql, definitions));
});

test('matching unsigned FLOAT definitions do not generate repeated corrections', () => {
  const source = new Map([['prices', numericDefinitions('CREATE TABLE `prices` (`price` float(8,3) unsigned NOT NULL DEFAULT 0.000)')]]);
  const target = new Map([['prices', { columns: [{ COLUMN_NAME: 'price', COLUMN_TYPE: 'float(8,3) unsigned' }] }]]);
  assert.equal(preserveNumericDefinitions('', source, target), '');
});

test('numeric column rename cannot silently bypass fidelity review', () => {
  assert.throws(() => preserveNumericDefinitions('ALTER TABLE `study` CHANGE COLUMN `diary_incentive` `price` double;', definitions, metadata('double')),
    /rename.*manual review/);
  assert.throws(() => assertNumericFidelity('ALTER TABLE `study` CHANGE COLUMN `diary_incentive` `price` double;', definitions),
    /rename.*manual review/);
});

test('preflight accepts equivalent keyword case and formatting without changing quoted values', () => {
  const sql = 'ALTER TABLE `study` MODIFY COLUMN `bonus_amount` DOUBLE(10, 2) NOT NULL DEFAULT 0.00;';
  assert.doesNotThrow(() => assertNumericFidelity(sql, definitions));
});
