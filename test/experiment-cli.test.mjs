import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExperimentArgs } from '../experiment-cli.mjs';

test('one experiment is a dry-run by default', () => {
  assert.deepEqual(parseExperimentArgs(['--experiment-id', '42']), {
    experimentIds: [42],
    loginCodes: [],
    allExperiments: false,
    execute: false,
    confirmTarget: undefined,
    confirmHost: undefined,
  });
});

test('one experiment requires target schema and host to execute', () => {
  assert.throws(
    () => parseExperimentArgs(['--experiment-id', '42', '--execute']),
    /requires/,
  );
  assert.deepEqual(parseExperimentArgs([
    '--experiment-id', '42', '--execute',
    '--confirm-target', 'migration_target', '--confirm-host', 'db.example',
  ]), {
    experimentIds: [42],
    loginCodes: [],
    allExperiments: false,
    execute: true,
    confirmTarget: 'migration_target',
    confirmHost: 'db.example',
  });
});

test('all experiments is explicit and cannot be combined with one ID', () => {
  assert.deepEqual(parseExperimentArgs(['--all-experiments']), {
    experimentIds: [],
    loginCodes: [],
    allExperiments: true,
    execute: false,
    confirmTarget: undefined,
    confirmHost: undefined,
  });
  assert.throws(() => parseExperimentArgs([
    '--all-experiments', '--experiment-id', '42',
  ]), /not both/);
  assert.throws(() => parseExperimentArgs(['--all-experiments', '--all-experiments']), /repeated/);
});

test('selected experiments accept any count of IDs and login codes', () => {
  assert.deepEqual(parseExperimentArgs([
    '--experiment-id', '2', '--experiment-id', '6', '--experiment-id', '2',
    '--login-code', 'CODE-A', '--login-code', 'CODE-B',
  ]), {
    experimentIds: [2, 6],
    loginCodes: ['CODE-A', 'CODE-B'],
    allExperiments: false,
    execute: false,
    confirmTarget: undefined,
    confirmHost: undefined,
  });
  assert.throws(() => parseExperimentArgs(['--login-code', '  ']), /cannot be empty/);
});

test('one experiment rejects unsafe identifiers and repeated options', () => {
  assert.throws(() => parseExperimentArgs(['--experiment-id', '0']), /positive integer/);
  assert.throws(() => parseExperimentArgs(['--experiment-id', '1 OR 1=1']), /positive integer/);
  assert.throws(() => parseExperimentArgs(['--experiment-id', '1', '--execute']), /requires/);
});
