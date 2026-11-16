import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkFixture } from '../benchmark-fixture.mjs';
import { summarizeBenchmark } from '../benchmark-report.mjs';
import { benchmarkDatabaseDigest } from '../benchmark-digest.mjs';

test('benchmark fixtures are deterministic, fully seeded and change seven related tables', () => {
  const fixture = benchmarkFixture(20);
  assert.deepEqual(fixture, benchmarkFixture(20));
  assert.equal(fixture.manifest.tables, 7);
  assert.equal(fixture.manifest.changedTables, 7);
  assert.equal(fixture.manifest.totalRows, 140);
  assert.equal(fixture.manifest.expectedTotalRows, 280);
  assert.equal((fixture.deltaSeed.match(/INSERT INTO/g) || []).length, 140);
  assert.match(fixture.deltaSeed, /VALUES \(21,/);
  assert.equal((fixture.seed.match(/INSERT INTO/g) || []).length, 140);
  assert.equal((fixture.baseline.match(/FOREIGN KEY/g) || []).length, 7);
  assert.equal((fixture.up.match(/ALTER TABLE/g) || []).length, 7);
  assert.equal((fixture.down.match(/ALTER TABLE/g) || []).length, 7);
  assert.throws(() => benchmarkFixture(0), /rows per table/);
});

test('benchmark fingerprints verify original row values and binary contents, not just counts', async () => {
  const definition = { columns: [{ COLUMN_NAME: 'id', COLUMN_TYPE: 'int' },
    { COLUMN_NAME: 'payload', COLUMN_TYPE: 'blob' }], identityKey: ['id'] };
  const metadata = new Map([['fixture_table', definition]]);
  const dependencies = { readState: async () => ({ fixture_table: definition }), readMetadata: async () => metadata };
  const inspect = payload => benchmarkDatabaseDigest({ async query(sql) {
    assert.match(sql, /^SELECT .* ORDER BY `id`$/);
    return [[{ id: '1', payload }]];
  } }, 'fabla_bench_test', dependencies);
  const before = await inspect(Buffer.from([0, 255]));
  assert.equal(before.totalRows, 1);
  assert.equal((await inspect(Buffer.from([0, 255]))).digest, before.digest);
  assert.notEqual((await inspect(Buffer.from([0, 254]))).digest, before.digest);
  await assert.rejects(inspect(new Date()), /dateStrings/);
  await assert.rejects(benchmarkDatabaseDigest({}, 'migration_target'), /disposable/);
});

function samples() {
  return ['ours', 'other'].flatMap(implementation => [1, 2, 3].map(run => ({
    implementation, runId: String(run), revision: `${implementation}-revision`,
    fixtureSha256: 'a'.repeat(64), host: 'fixture-rds', port: 3306, runner: 'same-runner',
    instanceClass: 'fixture-class', engineVersion: 'fixture-version', target: `fabla_bench_${implementation}_${run}`,
    tables: 7, changedTables: 7, totalRows: 7000, maintenance: true, backupVerified: true,
    schemaDifferences: 0, recordDifferences: 0, reversalDifferences: 0,
    beforeDigest: 'b'.repeat(64), restoredDigest: 'b'.repeat(64),
    expectedDigest: 'c'.repeat(64), afterDigest: 'c'.repeat(64), endToEndMs: run * 100,
    timingsMs: { comparison: run, backup: run, schema: run, records: run, verification: run, reversal: run },
  })));
}

test('benchmark reports separate phase medians and require repeated correct comparable runs', () => {
  const report = summarizeBenchmark(samples());
  assert.equal(report.implementations[0].medianEndToEndMs, 200);
  assert.equal(report.implementations[0].medianTimingsMs.backup, 2);
  for (const field of ['host', 'fixtureSha256', 'runner', 'expectedDigest', 'engineVersion']) {
    const runs = samples(); runs[0][field] = field.includes('Digest') || field.includes('Sha256') ? 'd'.repeat(64) : 'different';
    assert.throws(() => summarizeBenchmark(runs), /conditions|incorrect/);
  }
  const changed = samples(); changed[0].restoredDigest = 'd'.repeat(64);
  assert.throws(() => summarizeBenchmark(changed), /incorrect/);
  const repeated = samples(); repeated[1].target = repeated[0].target;
  assert.throws(() => summarizeBenchmark(repeated), /distinct fresh/);
  assert.throws(() => summarizeBenchmark(samples().slice(0, 4)), /at least three/);
});
