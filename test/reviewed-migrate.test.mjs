import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewedPlan } from '../reviewed-migrate.mjs';
import { assertAllowedSelection } from '../migration-policy.mjs';

const target = { host: 'test-host', port: 3306, schema: 'target' };
const migrations = [
  { name: '1_first.sql', version: '1', risk: 'additive', down: { risk: 'destructive' } },
  { name: '2_second.sql', version: '2', risk: 'additive', down: { risk: 'destructive' } },
];
const readers = { readSql: migration => `CREATE TABLE table_${migration.version} (id int);`,
  readReverse: migration => `DROP TABLE table_${migration.version};` };

test('reviewed plans skip completed revisions and reverse pending files newest first', () => {
  const all = reviewedPlan(migrations, [], target, readers);
  assert.equal(all.mode, 'reviewed');
  assert.match(all.reverseSql, /table_2;\nDROP TABLE table_1;/);
  const pending = reviewedPlan(migrations, [{ version: '1', applied: 1, total: 1 }], target, readers);
  assert.deepEqual(pending.migrations.map(migration => migration.version), ['2']);
});

test('reviewed approval binds forward SQL, reverse SQL, target, and pending history', () => {
  const original = reviewedPlan(migrations, [], target, readers).sha256;
  for (const changed of [
    reviewedPlan(migrations, [], { ...target, schema: 'another' }, readers),
    reviewedPlan(migrations, [], target, { ...readers, readSql: () => 'DROP TABLE changed;' }),
    reviewedPlan(migrations, [], target, { ...readers, readReverse: () => 'DROP TABLE changed;' }),
    reviewedPlan(migrations, [{ version: '1', applied: 1, total: 1 }], target, readers),
  ]) assert.notEqual(changed.sha256, original);
});

test('unknown and partial history cannot be silently deployed', () => {
  assert.throws(() => reviewedPlan(migrations, [{ version: '9' }], target, readers), /unknown/);
  const plan = reviewedPlan(migrations, [{ version: '1', applied: 0, total: 1 }], target, readers);
  assert.throws(() => assertAllowedSelection(plan.migrations, { execute: true }), /partially/);
  const progressed = reviewedPlan(migrations, [{ version: '1', applied: 1, total: 2 }], target, readers);
  assert.notEqual(plan.sha256, progressed.sha256);
});

test('destructive review requires explicit approval and one file', () => {
  const plan = reviewedPlan([{ ...migrations[0], risk: 'destructive' }], [], target, readers);
  assert.equal(plan.risk, 'destructive');
  assert.throws(() => assertAllowedSelection(plan.migrations, { execute: true }), /allow-destructive/);
  assert.doesNotThrow(() => assertAllowedSelection(plan.migrations, { execute: true, allowDestructive: true }));
});
