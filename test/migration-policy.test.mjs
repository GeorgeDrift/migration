import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAllowedSelection, loadMigrations, pendingMigrations } from '../migration-policy.mjs';

const files = [
  { name: '202609250001_baseline.sql', version: '202609250001', risk: 'additive' },
  { name: '202609250002_change.sql', version: '202609250002', risk: 'additive' },
  { name: '202609250003_reverse.sql', version: '202609250003', risk: 'destructive' },
];

test('an empty migration list has no pending revisions', () => {
  assert.deepEqual(pendingMigrations([], []), []);
});

test('registered migration files pass policy validation', () => {
  assert.doesNotThrow(() => loadMigrations());
});

test('partial revisions remain pending so Atlas can resume them', () => {
  const pending = pendingMigrations(files, [
    { version: files[0].version, applied: 7, total: 7, error: '' },
    { version: files[1].version, applied: 3, total: 7, error: 'connection lost' },
  ]);
  assert.equal(pending[0].version, files[1].version);
  assert.equal(pending[0].partial, true);
  assert.throws(() => assertAllowedSelection(pending.slice(0, 1), {
    action: 'apply', allowDestructive: false, execute: true,
  }), /partially recorded/);
  assert.doesNotThrow(() => assertAllowedSelection(pending.slice(0, 1), {
    action: 'apply', allowDestructive: false, execute: true, resumePartial: true,
  }));
});

test('unknown and out-of-order histories stop the runner', () => {
  assert.throws(() => pendingMigrations(files, [{ version: 'other', applied: 1, total: 1 }]), /unknown/);
  assert.throws(() => pendingMigrations(files, [
    { version: files[1].version, applied: 7, total: 7 },
  ]), /out of order/);
});

test('generic multi-file apply cannot silently include a destructive file', () => {
  assert.throws(() => assertAllowedSelection(files, { action: 'apply', allowDestructive: false }), /destructive/);
  assert.throws(() => assertAllowedSelection(files, { action: 'apply', allowDestructive: true }), /single-migration/);
  assert.doesNotThrow(() => assertAllowedSelection([files[2]], {
    action: 'apply', allowDestructive: true,
  }));
});
