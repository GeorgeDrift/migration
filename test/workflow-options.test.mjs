import assert from 'node:assert/strict';
import test from 'node:test';
import { contentStages, parseWorkflowArgs, requiresSchemaApply } from '../workflow-options.mjs';

test('nine explicit choices keep record and procedure scopes separate', () => {
  const cases = [
    ['schema', []],
    ['all-data', ['all-data']],
    ['stored-procedures', ['stored-procedures']],
    ['one-experiment', ['one-experiment']],
    ['one-experiment-with-procedures', ['one-experiment', 'stored-procedures']],
    ['all', ['all-data', 'stored-procedures']],
    ['experiment-only', ['one-experiment']],
    ['procedures-only', ['stored-procedures']],
    ['records-only', ['all-data']],
  ];
  for (const [choice, stages] of cases) {
    const args = choice.includes('experiment') ? [choice, '--experiment-id', '42'] : [choice];
    assert.deepEqual(contentStages(parseWorkflowArgs(args)), stages, choice);
  }
  assert.equal(requiresSchemaApply('experiment-only'), true);
  assert.equal(requiresSchemaApply('procedures-only'), false);
  assert.equal(requiresSchemaApply('records-only'), false);
  assert.equal(requiresSchemaApply('unknown'), false);
  assert.equal(requiresSchemaApply('one-experiment'), true);
  assert.deepEqual(contentStages(parseWorkflowArgs([
    'one-experiment', '--experiment-id', '42', '--with-procedures',
  ])), ['one-experiment', 'stored-procedures']);
});

test('standalone choices cannot expand their scope to other content', () => {
  for (const choice of ['records-only', 'procedures-only']) {
    assert.throws(() => parseWorkflowArgs([choice, '--with-procedures']), /Unknown/);
    assert.throws(() => parseWorkflowArgs([choice, '--experiment-id', '42']), /only valid/);
    assert.throws(() => parseWorkflowArgs([choice, '--execute']), /requires/);
    assert.equal(parseWorkflowArgs([choice]).execute, false);
  }
});

test('experiment selection and exact write confirmation are mandatory', () => {
  assert.throws(() => parseWorkflowArgs(['one-experiment']), /positive/);
  assert.throws(() => parseWorkflowArgs(['experiment-only']), /positive/);
  assert.equal(parseWorkflowArgs(['experiment-only', '--all-experiments']).allExperiments, true);
  assert.deepEqual(parseWorkflowArgs([
    'experiment-only', '--experiment-id', '2', '--experiment-id', '6',
    '--login-code', 'CODE-A',
  ]).experimentIds, [2, 6]);
  assert.deepEqual(parseWorkflowArgs([
    'experiment-only', '--login-code', 'CODE-A', '--login-code', 'CODE-B',
  ]).loginCodes, ['CODE-A', 'CODE-B']);
  assert.throws(() => parseWorkflowArgs([
    'experiment-only', '--all-experiments', '--experiment-id', '42',
  ]), /not both/);
  assert.throws(() => parseWorkflowArgs(['one-experiment', '--all-experiments']), /Unknown/);
  assert.throws(() => parseWorkflowArgs([
    'one-experiment', '--experiment-id', '2', '--experiment-id', '6',
  ]), /repeated only/);
  assert.throws(() => parseWorkflowArgs(['one-experiment-with-procedures']), /positive/);
  assert.throws(() => parseWorkflowArgs(['one-experiment', '--experiment-id', '0']), /positive/);
  assert.throws(() => parseWorkflowArgs(['all-data', '--execute']), /requires/);
  assert.throws(() => parseWorkflowArgs(['schema', '--with-procedures']), /Unknown/);
  assert.equal(parseWorkflowArgs([
    'schema', '--execute', '--confirm-target', 'target', '--confirm-host', 'host',
  ]).execute, true);
});
