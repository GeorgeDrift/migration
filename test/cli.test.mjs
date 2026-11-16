import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '../cli.mjs';

test('previews one pending target migration by default', () => {
  assert.deepEqual(parseArgs(['apply', 'target']), {
    action: 'apply', database: 'target', count: '1', allowDirty: false,
    allowDestructive: false, resumePartial: false, execute: false,
    confirmTarget: undefined, confirmHost: undefined,
  });
});

test('accepts positive migration counts and requires full write confirmation', () => {
  assert.equal(parseArgs(['apply', 'target', '--count', '17']).count, '17');
  assert.throws(() => parseArgs(['apply', 'target', '--execute']), /requires/);
  assert.doesNotThrow(() => parseArgs([
    'apply', 'target', '--execute', '--confirm-target', 'migration_target',
    '--confirm-host', 'db.example',
  ]));
});

test('rejects invalid and demo-only flags', () => {
  assert.throws(() => parseArgs(['apply', 'target', '--count', '0']), /positive integer/);
  assert.throws(() => parseArgs(['apply', 'target', '--count', '1.5']), /positive integer/);
  assert.throws(() => parseArgs(['apply', 'target', '--count', 'all']), /positive integer/);
  assert.throws(() => parseArgs(['apply', 'dev']), /Usage/);
  assert.throws(() => parseArgs(['status', 'dev', '--execute']), /read-only/);
  assert.throws(() => parseArgs(['reverse-demo', 'dev']), /Usage/);
});
