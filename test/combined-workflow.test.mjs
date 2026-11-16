import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkflow } from '../tool.mjs';
import { contentStages, parseWorkflowArgs } from '../workflow-options.mjs';

const databases = {
  dev: { schema: 'migration_dev', host: 'test-host', port: 3306 },
  target: { schema: 'migration_target', host: 'test-host', port: 3306 },
};
const SHA = 'a'.repeat(64);
const different = { status: 'different', differences: ['study'] };
const ready = { status: 'ready', differences: [] };
const change = { sql: 'ALTER TABLE study ADD x int;\n', sha256: SHA, statements: ['ALTER TABLE study ADD x int'],
  reverseSql: 'ALTER TABLE study DROP x;\n' };

function options(choice, execute = true, expect = SHA) {
  const args = [choice];
  if (choice.includes('experiment')) args.push('--experiment-id', '42');
  if (execute) {
    if (expect) args.push('--expect-change', expect);
    args.push('--execute', '--confirm-target', 'migration_target', '--confirm-host', 'test-host');
  }
  return parseWorkflowArgs(args);
}

function dependencies({ initial = different, after = ready, failPreview = false } = {}) {
  const calls = [];
  const reports = [];
  const printed = [];
  let inspections = 0;
  let first;
  return {
    calls, reports, printed,
    async inspect() { calls.push('inspect'); return inspections++ ? after : initial; },
    async generate() { calls.push('generate'); return change; },
    async applyChange(dbs, ca, applied, recovery) {
      assert.equal(applied, change);
      assert.ok(recovery.first, 'a checkpoint must exist before schema SQL runs');
      calls.push('schema-write');
      return { before: { study: { v: 1 } }, after: { study: { v: 2 } } };
    },
    async recordChange(applied, states, checkpoint) {
      calls.push(`record:${checkpoint.id}`);
      return { id: '1791147653833-record' };
    },
    async openRecovery() {
      return {
        root: '/recovery',
        get first() { return first; }, get last() { return first; },
        async checkpoint(label) { calls.push(`checkpoint:${label}`); first ||= { id: 'test-checkpoint' }; return first; },
        async restore(record) { calls.push('restore'); return record; },
        async assertSafe() {},
        async close() {},
      };
    },
    async runChild(script, args) {
      const execute = args.includes('--execute');
      calls.push(`${script}:${execute ? 'write' : 'preview'}`);
      if (!execute && script !== 'one-experiment.mjs') assert.ok(args.includes('--strict-preview'));
      if (failPreview && !execute) throw new Error('Content preview failed');
      if (execute) {
        assert.ok(args.includes('migration_target'));
        assert.ok(args.includes('test-host'));
      }
    },
    print(text) { printed.push(text); if (text.startsWith('{')) reports.push(JSON.parse(text)); },
  };
}

const schemaSteps = ['inspect', 'generate', 'checkpoint:Before schema change aaaaaaaaaaaa', 'schema-write', 'inspect',
  'record:test-checkpoint'];

test('unreviewed drift and destructive reviewed plans stop before checkpoint creation', async () => {
  const empty = dependencies();
  empty.generate = async () => ({ ...change, mode: 'reviewed', migrations: [] });
  await assert.rejects(runWorkflow(options('schema'), databases, null, empty), /no pending reviewed migration/);
  assert.ok(!empty.calls.some(call => call.startsWith('checkpoint')));
  const destructive = dependencies();
  destructive.generate = async () => ({ ...change, mode: 'reviewed', risk: 'destructive',
    migrations: [{ name: '1_drop.sql', risk: 'destructive' }] });
  await assert.rejects(runWorkflow(options('schema'), databases, null, destructive), /allow-destructive/);
  assert.ok(!destructive.calls.some(call => call.startsWith('checkpoint')));
});

test('phase timings include protected backups and distinguish schema, records and verification', async () => {
  const deps = dependencies();
  let ticks = 0;
  deps.clock = () => ++ticks;
  const report = await runWorkflow(options('all-data'), databases, Buffer.alloc(0), deps);
  assert.deepEqual(Object.keys(report.timingsMs).sort(),
    ['backup', 'comparison', 'lockAndPreflight', 'records', 'schema', 'verification']);
  assert.equal(report.executed, true);
});

test('schema-inclusive workflows compare live, checkpoint, apply, verify, record, then copy content', async () => {
  for (const choice of ['schema', 'all-data', 'stored-procedures', 'one-experiment',
    'one-experiment-with-procedures', 'all', 'experiment-only']) {
    const deps = dependencies();
    const opts = options(choice);
    const report = await runWorkflow(opts, databases, Buffer.alloc(0), deps);
    const preflight = opts.withProcedures ? ['copy-procedures.mjs:preview'] : [];
    const steps = [schemaSteps[0], ...preflight, ...schemaSteps.slice(1)];
    assert.deepEqual(deps.calls.slice(0, steps.length), steps);
    const expected = contentStages(opts).map(stage => ({
      'all-data': 'copy-data.mjs', 'stored-procedures': 'copy-procedures.mjs',
      'one-experiment': 'one-experiment.mjs',
    }[stage]));
    assert.deepEqual(deps.calls.slice(steps.length).filter(call => !call.startsWith('checkpoint')), [
      ...expected.map(script => `${script}:preview`), ...expected.map(script => `${script}:write`), 'inspect',
    ]);
    assert.equal(report.executed, true);
    assert.equal(report.schemaChange.record, '1791147653833-record');
  }
});

test('matching live schemas need no schema change and copy only the selected content', async () => {
  for (const [choice, script] of [['records-only', 'copy-data.mjs'], ['procedures-only', 'copy-procedures.mjs'], ['all-data', 'copy-data.mjs']]) {
    for (const execute of [false, true]) {
      const deps = dependencies({ initial: ready });
      const report = await runWorkflow(options(choice, execute, null), databases, Buffer.alloc(0), deps);
      assert.ok(!deps.calls.includes('generate') && !deps.calls.includes('schema-write'));
      assert.ok(deps.calls.includes(`${script}:preview`));
      assert.equal(deps.calls.includes(`${script}:write`), execute);
      assert.equal(report.executed, execute);
    }
  }
});

test('content-only choices refuse differing live schemas before any backup or content', async () => {
  for (const choice of ['records-only', 'procedures-only']) {
    for (const execute of [false, true]) {
      const deps = dependencies();
      deps.openRecovery = async () => { throw new Error('Must not open recovery'); };
      await assert.rejects(runWorkflow(options(choice, execute, null), databases, Buffer.alloc(0), deps), /does not change schema/);
      assert.deepEqual(deps.calls, ['inspect']);
    }
  }
});

test('a preview shows the generated SQL and its reverse without any write', async () => {
  const deps = dependencies();
  deps.openRecovery = async () => { throw new Error('Must not open recovery'); };
  const report = await runWorkflow(options('all', false), databases, Buffer.alloc(0), deps);
  assert.deepEqual(deps.calls, ['inspect', 'generate']);
  assert.equal(report.executed, false);
  assert.deepEqual(report.schemaChange, { sha256: SHA, statements: 1, sql: change.sql, reverseSql: change.reverseSql });
  assert.deepEqual(report.deferredContentStages, ['all-data', 'stored-procedures']);
});

test('execution applies only the exact SQL that was previewed', async () => {
  for (const [expect, message] of [[null, /requires --expect-change/], ['b'.repeat(64), /changed since the preview/]]) {
    const deps = dependencies();
    deps.openRecovery = async () => { throw new Error('Must not open recovery'); };
    await assert.rejects(runWorkflow(options('schema', true, expect), databases, Buffer.alloc(0), deps), message);
    assert.deepEqual(deps.calls, ['inspect', 'generate']);
  }
  const wrong = { ...options('all'), confirmTarget: 'migration_dev' };
  await assert.rejects(runWorkflow(wrong, databases, Buffer.alloc(0), dependencies()), /Confirm target/);
});

test('a target that still differs after the schema SQL is restored to the checkpoint', async () => {
  const deps = dependencies({ after: { status: 'different', differences: ['study'] } });
  await assert.rejects(runWorkflow(options('all-data'), databases, Buffer.alloc(0), deps), /still differs from the source after the schema change: study/);
  assert.ok(deps.calls.includes('restore'));
  assert.ok(!deps.calls.some(call => call.startsWith('copy-data.mjs')));
  assert.equal(deps.reports.at(-1).rollback.status, 'verified');
  assert.equal(deps.reports.at(-1).executed, false);
});

test('schema SQL failure restores the checkpoint and no record is written', async () => {
  const deps = dependencies();
  deps.applyChange = async () => { deps.calls.push('schema-write'); throw new Error('Duplicate column name'); };
  await assert.rejects(runWorkflow(options('schema'), databases, Buffer.alloc(0), deps), /Duplicate column name/);
  assert.ok(deps.calls.includes('restore'));
  assert.ok(!deps.calls.some(call => call.startsWith('record:')));
});

test('a rollback record that cannot be saved never undoes or blocks the migration', async () => {
  const deps = dependencies();
  deps.recordChange = async () => { throw new Error('aws s3 cp failed'); };
  const report = await runWorkflow(options('all-data'), databases, Buffer.alloc(0), deps);
  assert.equal(report.executed, true);
  assert.ok(!deps.calls.includes('restore'));
  assert.match(report.schemaChange.recordWarning, /aws s3 cp failed.*checkpoint test-checkpoint/);
  assert.ok(deps.calls.includes('copy-data.mjs:write'));
});

test('standalone content failure restores the checkpoint', async () => {
  for (const [choice, script] of [['records-only', 'copy-data.mjs'], ['procedures-only', 'copy-procedures.mjs']]) {
    const deps = dependencies({ initial: ready });
    const run = deps.runChild;
    deps.runChild = async (name, args) => {
      await run(name, args);
      if (args.includes('--execute')) throw new Error('Content write failed');
    };
    await assert.rejects(runWorkflow(options(choice, true, null), databases, Buffer.alloc(0), deps), /Content write failed/);
    assert.ok(deps.calls.includes(`${script}:write`));
    assert.equal(deps.reports.at(-1).rollback.status, 'verified');
    assert.equal(deps.reports.at(-1).executed, false);
  }
});

test('recovery setup and content preview failures cannot write', async () => {
  for (const choice of ['records-only', 'procedures-only']) {
    const deps = dependencies({ initial: ready });
    deps.openRecovery = async () => { throw new Error('Durable backup storage missing'); };
    await assert.rejects(runWorkflow(options(choice, true, null), databases, Buffer.alloc(0), deps), /backup storage missing/);
    assert.ok(!deps.calls.some(call => call.endsWith(':write')));
    const previewDeps = dependencies({ initial: ready, failPreview: true });
    previewDeps.openRecovery = async () => { throw new Error('Must not open recovery'); };
    await assert.rejects(runWorkflow(options(choice, true, null), databases, Buffer.alloc(0), previewDeps), /Content preview failed/);
    assert.ok(!previewDeps.calls.some(call => call.endsWith(':write')));
  }
  const schemaDeps = dependencies();
  schemaDeps.openRecovery = async () => { throw new Error('Durable backup storage missing'); };
  await assert.rejects(runWorkflow(options('schema'), databases, Buffer.alloc(0), schemaDeps), /backup storage missing/);
  assert.ok(!schemaDeps.calls.includes('schema-write'));
});

test('content preview failure after the schema change restores the checkpoint', async () => {
  const deps = dependencies({ failPreview: true });
  await assert.rejects(runWorkflow(options('all-data'), databases, Buffer.alloc(0), deps), /Content preview failed/);
  assert.ok(!deps.calls.some(call => call.endsWith('.mjs:write')));
  assert.equal(deps.reports.at(-1).rollback.status, 'verified');
});

test('a procedure preflight failure stops before any schema or content write', async () => {
  for (const choice of ['all', 'stored-procedures', 'one-experiment-with-procedures']) {
    const deps = dependencies();
    deps.openRecovery = async () => { throw new Error('Must not open recovery'); };
    const run = deps.runChild;
    deps.runChild = async (script, args) => {
      await run(script, args);
      if (script === 'copy-procedures.mjs') throw new Error('Procedure definer is missing');
    };
    await assert.rejects(runWorkflow(options(choice), databases, Buffer.alloc(0), deps), /definer is missing/);
    assert.deepEqual(deps.calls, ['inspect', 'copy-procedures.mjs:preview']);
    assert.equal(deps.reports.at(-1).writeAttempted, undefined);
  }
});

test('automatic restore failure is reported explicitly', async () => {
  const deps = dependencies({ after: { status: 'different', differences: ['study'] } });
  const open = deps.openRecovery;
  deps.openRecovery = async () => {
    const recovery = await open();
    recovery.restore = async () => { throw new Error('Restore connection failed'); };
    return recovery;
  };
  await assert.rejects(runWorkflow(options('all'), databases, Buffer.alloc(0), deps), /still differs/);
  assert.equal(deps.reports.at(-1).rollback.status, 'failed');
  assert.equal(deps.reports.at(-1).executed, true);
});

test('final schema mismatch after content writes restores the original checkpoint', async () => {
  const deps = dependencies();
  let inspections = 0;
  deps.inspect = async () => {
    inspections += 1;
    return inspections === 1 ? different : inspections === 2 ? ready : { status: 'different', differences: ['study'] };
  };
  await assert.rejects(runWorkflow(options('all'), databases, Buffer.alloc(0), deps), /Final schema verification failed/);
  assert.ok(deps.calls.includes('copy-data.mjs:write'));
  assert.equal(deps.reports.at(-1).rollback.status, 'verified');
  assert.equal(deps.reports.at(-1).executed, false);
});

test('executed runs end with a plain result naming what was and was not migrated', async () => {
  const result = async (choice, initial = different) => {
    const deps = dependencies({ initial });
    const saved = [];
    deps.saveSummary = text => saved.push(text);
    await runWorkflow(options(choice, true, initial === different ? SHA : undefined), databases, Buffer.alloc(0), deps);
    assert.equal(deps.printed.at(-1), saved[0]);
    return saved[0].split('\n').slice(1);
  };
  assert.deepEqual(await result('schema'), ['Finished.',
    'Schema            | YES - 1 schema statement applied',
    'Records           | NO  - not part of this choice',
    'Stored procedures | NO  - not part of this choice']);
  assert.deepEqual((await result('all-data', ready)).slice(1), [
    'Schema            | YES - already matched the source; no change needed',
    'Records           | YES - all records copied',
    'Stored procedures | NO  - not part of this choice']);
  assert.deepEqual((await result('all')).slice(1), [
    'Schema            | YES - 1 schema statement applied',
    'Records           | YES - all records copied',
    'Stored procedures | YES - approved procedures copied']);
  assert.deepEqual((await result('records-only', ready)).slice(1), [
    'Schema            | NO  - not part of this choice',
    'Records           | YES - all records copied',
    'Stored procedures | NO  - not part of this choice']);
});

test('a rolled-back run says nothing from it remains, and previews print no result', async () => {
  const deps = dependencies({ after: { status: 'different', differences: ['study'] } });
  const saved = [];
  deps.saveSummary = text => saved.push(text);
  await assert.rejects(runWorkflow(options('all-data'), databases, Buffer.alloc(0), deps));
  assert.match(saved[0], /FAILED: The target still differs/);
  assert.match(saved[0], /Rolled back to checkpoint test-checkpoint; nothing from this run remains/);
  assert.match(saved[0], /Schema {12}\| NO  - not completed\nRecords {11}\| NO  - not completed/);
  const preview = dependencies();
  preview.saveSummary = () => assert.fail('a preview must not record a migration result');
  await runWorkflow(options('all-data', false), databases, Buffer.alloc(0), preview);
  assert.ok(preview.printed.at(-1).startsWith('{'));
});
