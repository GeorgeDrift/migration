import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { numericDefinitions, replayNumericCorrections, assertNumericFidelity } from '../numeric-fidelity.mjs';
import { inspectFreshReplay, isEmptyTarget, validateNumericSelection } from '../fresh-replay.mjs';

const desired = 'CREATE TABLE `study` (`study_id` int, `diary_incentive` double(10,2) NOT NULL DEFAULT 0.00, `bonus_amount` double(10,2) NOT NULL DEFAULT 0.00)';
const original = desired.replaceAll('double(10,2)', 'double') + ';\n';
const source = new Map([['study', numericDefinitions(desired)]]);
const baseline = { name: '001_baseline.sql', version: '001', sql: original, risk: 'additive' };
const correction = { name: '002_correction.sql', version: '002', sql: replayNumericCorrections(original, source), risk: 'destructive' };
const empty = { emptyTarget: true, hasRevisionHistory: false, allowDestructive: true };
const databases = { dev: { schema: 'migration_dev' }, target: { schema: 'migration_target' } };

function target(count) {
  if (arguments.length === 0) count = 0;
  return { execute: async (sql, args) => {
    assert.match(sql, /information_schema\.TABLES/);
    for (const catalog of ['ROUTINES', 'TRIGGERS', 'EVENTS']) assert.ok(sql.includes(`information_schema.${catalog}`));
    assert.deepEqual(args, Array(4).fill('migration_target'));
    return [[{ objectCount: count }]];
  } };
}

function sourceConnection() {
  return {
    execute: async sql => { assert.match(sql, /^SELECT DISTINCT TABLE_NAME/); return [[{ TABLE_NAME: 'study' }]]; },
    query: async sql => { assert.equal(sql, 'SHOW CREATE TABLE `migration_dev`.`study`'); return [[{ 'Create Table': desired }]]; },
  };
}

test('historical replay proposes exact numeric corrections without replacing CREATE SQL', () => {
  assert.equal(baseline.sql, original);
  assert.match(correction.sql, /ALTER TABLE `study`/);
  assert.equal((correction.sql.match(/double\(10,2\)/g) || []).length, 2);
  assert.equal((correction.sql.match(/DEFAULT 0\.00/g) || []).length, 2);
  assert.doesNotThrow(() => assertNumericFidelity(correction.sql, source));
  assert.equal(replayNumericCorrections(original + correction.sql, source), '');
});

test('empty replay accepts old numeric types only with the reviewed complete correction chain', () => {
  assert.equal(validateNumericSelection([baseline], [baseline, correction], source, empty), true);
  assert.equal(validateNumericSelection([correction], [correction], source), false);
  assert.throws(() => validateNumericSelection([baseline], [baseline], source, empty), /reviewed numeric correction/);
  const incomplete = { ...correction, sql: 'ALTER TABLE `study` MODIFY COLUMN `diary_incentive` double(10,2) NOT NULL DEFAULT 0.00;' };
  assert.throws(() => validateNumericSelection([baseline], [baseline, incomplete], source, empty), /reviewed numeric correction/);
});

test('existing tables, any revision history, partial journals and missing approval cannot bypass fidelity', () => {
  for (const flags of [{ ...empty, emptyTarget: false }, { ...empty, hasRevisionHistory: true }]) {
    assert.throws(() => validateNumericSelection([baseline], [baseline, correction], source, flags), /SQL loses/);
  }
  assert.throws(() => validateNumericSelection([baseline], [baseline, { ...correction, partial: true }], source, empty), /Partial history/);
  assert.throws(() => validateNumericSelection([baseline], [baseline, correction], source, { ...empty, allowDestructive: false }), /explicit --allow-destructive/);
});

test('unsafe historical replay cannot silently include data writes, drops, renames or duplicate creates', () => {
  for (const extra of ['INSERT INTO `study` VALUES (1, 2, 3);', 'DROP TABLE `study`;',
    'USE `migration_dev`;', 'ALTER TABLE `study` CHANGE COLUMN `bonus_amount` `x` double;',
    'ALTER TABLE `other` MODIFY COLUMN `x` double;', original]) {
    assert.throws(() => replayNumericCorrections(original + extra + correction.sql, source), /manual review/);
  }
  assert.throws(() => replayNumericCorrections('CREATE TABLE `study` (`study_id` int);', source), /omits.*diary_incentive/);
  assert.throws(() => replayNumericCorrections('CREATE TABLE `other` (`id` int);', source), /does not create study/);
});

test('only completely empty targets are eligible, including absence of views and routines', async () => {
  assert.equal(await isEmptyTarget(target('0'), 'migration_target'), true);
  assert.equal(await isEmptyTarget(target('1'), 'migration_target'), false);
  assert.equal(await isEmptyTarget(target('9007199254740993'), 'migration_target'), false);
  for (const objectCount of [undefined, null, 'unknown', '-1']) {
    await assert.rejects(isEmptyTarget(target(objectCount), 'migration_target'), /Cannot verify/);
  }
});

test('fresh replay inspection requests correction once and recognizes it on subsequent fresh runs', async () => {
  const before = await inspectFreshReplay(sourceConnection(), target(), databases, [baseline], { hasRevisionHistory: false });
  assert.equal(before.correctionSql, correction.sql);
  const after = await inspectFreshReplay(sourceConnection(), target(), databases, [baseline, correction], { hasRevisionHistory: false });
  assert.equal(after.correctionSql, '');
  assert.equal(await inspectFreshReplay(sourceConnection(), target(1), databases, [baseline], { hasRevisionHistory: false }), undefined);
  assert.equal(await inspectFreshReplay(sourceConnection(), target(), databases, [baseline], { hasRevisionHistory: true }), undefined);
});

test('strict validation still rejects wrong defaults, scale and unsigned source changes', () => {
  for (const sql of [correction.sql.replaceAll('double(10,2)', 'double(8,2)'),
    correction.sql.replaceAll('DEFAULT 0.00', 'DEFAULT 1.00'),
    correction.sql.replaceAll('double(10,2)', 'double(10,2) unsigned')]) {
    assert.throws(() => validateNumericSelection([baseline], [baseline, { ...correction, sql }], source, empty), /reviewed numeric correction/);
  }
});

test('the actual historical baseline stays byte-identical while its corrected replay is valid', () => {
  const bytes = readFileSync(new URL('../migrations/202610020001_create_target_tables.sql', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '4362dd3c29d1cef70fe238d0fbda3999bb7de42eaf17b17caf28ff5f84bf0939');
  const historical = { ...baseline, sql: bytes.toString('utf8') };
  const sql = replayNumericCorrections(historical.sql, source);
  assert.equal(validateNumericSelection([historical], [historical, { ...correction, sql }], source, empty), true);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '4362dd3c29d1cef70fe238d0fbda3999bb7de42eaf17b17caf28ff5f84bf0939');
});
