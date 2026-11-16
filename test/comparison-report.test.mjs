import assert from 'node:assert/strict';
import test from 'node:test';
import { formatComparison } from '../comparison-report.mjs';

function report(overrides = {}) {
  return {
    source: { schema: 'migration_dev', host: 'test-host' },
    target: { schema: 'migration_target', host: 'test-host' },
    sourceTableCount: 12, targetTableCount: 8,
    tables: [{ table: 'experiment', schema: 'identical', fields: [] }],
    complete: true, ...overrides,
  };
}

test('report displays only schema resources and definitions', () => {
  const text = formatComparison(report());
  assert.match(text, /Table schemas\s+\| 12\s+\| 8\s+\| 1\s+\| 0/);
  assert.match(text, /Schema differences/);
  assert.match(text, /TABLE SCHEMAS/);
  assert.match(text, /experiment\s+\| Present\s+\| Present\s+\| Same/);
  assert.doesNotMatch(text, /procedures|functions|triggers|views|events/i);
  assert.doesNotMatch(text, /Total records|Source rows|Changed rows|\|\s*Data/);
});

test('resource summary exposes matching and different table schema totals', () => {
  const text = formatComparison(report({ sourceTableCount: 15, targetTableCount: 15, tables: [
    ...Array.from({ length: 14 }, (_, index) => ({ table: `same_${index}`, schema: 'identical', fields: [] })),
    { table: 'changed', schema: 'different', fields: [{ field: 'columns.1', source: {}, target: null }] },
  ] }));
  assert.match(text, /Table schemas\s+\| 15\s+\| 15\s+\| 14\s+\| 1/);
});

test('missing target tables are clearly reported', () => {
  const text = formatComparison(report({ tables: [
    { table: 'study', schema: 'source-only', fields: [] },
  ] }));
  assert.match(text, /study\s+\| Present\s+\| Missing\s+\| Missing from target/);
  assert.match(text, /study: present in source, missing from target/);
});

test('schema differences identify source and target definitions', () => {
  const text = formatComparison(report({ tables: [
    { table: 'study', schema: 'different',
      fields: [{ field: 'columns.9.COLUMN_DEFAULT', source: '0', target: '0.00' }] },
  ] }));
  assert.match(text, /SCHEMA DIFFERENCES: study/);
  assert.match(text, /columns\.9\.COLUMN_DEFAULT\s+\| "0"\s+\| "0\.00"/);
});

test('unavailable table definitions mark the schema comparison incomplete', () => {
  const text = formatComparison(report({ complete: false }));
  assert.match(text, /Schema comparison is incomplete/);
});
