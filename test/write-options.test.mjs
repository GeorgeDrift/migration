import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWriteOptions } from '../write-options.mjs';

test('strict content preview is explicitly read-only', () => {
  const options = parseWriteOptions(['--strict-preview'], 'usage');
  assert.equal(options.strictPreview, true);
  assert.equal(options.execute, false);
});

test('strict preview cannot be combined with writes or repeated', () => {
  assert.throws(() => parseWriteOptions(['--strict-preview', '--execute',
    '--confirm-target', 'target', '--confirm-host', 'host'], 'usage'), /read-only/);
  assert.throws(() => parseWriteOptions(['--strict-preview', '--strict-preview'], 'usage'), /repeated/);
});
