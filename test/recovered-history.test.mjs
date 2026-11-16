import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { loadMigrations, pendingMigrations } from '../migration-policy.mjs';

const root = new URL('../migrations/', import.meta.url);
const name = '202610020001_create_target_tables.sql';

test('recovered historical baseline exactly matches the originally approved bytes', () => {
  const sql = readFileSync(new URL(name, root));
  const hash = createHash('sha256').update(sql).digest('hex');
  assert.equal(hash, '4362dd3c29d1cef70fe238d0fbda3999bb7de42eaf17b17caf28ff5f84bf0939');
  assert.equal(sql.toString().includes('\r'), false);
  assert.equal(loadMigrations().find(file => file.name === name)?.risk, 'additive');
});

test('completed historical revision is recognized and not selected for replay', () => {
  const migrations = loadMigrations();
  const pending = pendingMigrations(migrations, [
    { version: '202610020001', applied: 12, total: 12, error: null },
  ]);
  assert.ok(!pending.some(file => file.version === '202610020001'));
  assert.throws(() => pendingMigrations(migrations, [
    { version: '202610020001', applied: 12, total: 12, error: null },
    { version: '202610020001', applied: 12, total: 12, error: null },
  ]), /unknown or duplicate/);
});

test('restored atlas.sum follows Atlas cumulative filename and content checksums', () => {
  // Matches Atlas sql/migrate/dir.go NewHashFile and HashFile.Sum.
  const cumulative = createHash('sha256');
  const entries = readdirSync(root).filter(file => file.endsWith('.sql')).sort().map(file => {
    cumulative.update(file).update(readFileSync(new URL(file, root)));
    return [file, cumulative.copy().digest('base64')];
  });
  const total = createHash('sha256');
  for (const [file, sum] of entries) total.update(file).update(sum);
  const expected = 'h1:' + total.digest('base64') + '\n'
    + entries.map(([file, sum]) => file + ' h1:' + sum + '\n').join('');
  assert.equal(readFileSync(new URL('atlas.sum', root), 'utf8'), expected);
});
