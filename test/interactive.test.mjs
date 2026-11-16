import assert from 'node:assert/strict';
import test from 'node:test';
import { interactive, selectionArgs, comparisonFromOutput, reportFromOutput, menu, offerRollback } from '../interactive.mjs';
import { requiresSchemaApply } from '../workflow-options.mjs';

const databases = { target: { schema: 'migration_target', host: 'test-host' } };
const noProcedures = async () => ({ plan: { definer: { user: 'admin', host: '%' }, pending: [] } });
const SHA = 'c'.repeat(64);
const schemaChange = { sha256: SHA, statements: 1, sql: 'ALTER TABLE study ADD x int;\n', reverseSql: 'ALTER TABLE study DROP x;\n' };

// Like tool.mjs schema: the comparison stage, then the preview report (with SQL when schemas differ).
function comparison(status = 'ready') {
  const stage = { stage: 'schema', status, differences: status === 'ready' ? [] : ['study'] };
  const report = { choice: 'schema', executed: false, ...(status === 'different' ? { schemaChange } : {}) };
  return `${JSON.stringify(stage, null, 2)}\n${JSON.stringify(report)}\n`;
}
function preview(choice, status) {
  const report = { choice, executed: false, ...(status === 'different' ? { schemaChange } : {}) };
  return `Previewing...\n${JSON.stringify(report)}\n`;
}
// Comparison for ["schema"], a preview report for a selected option, and plain output for execution.
function runner(status = 'ready', { failPreview = false } = {}) {
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (args.length === 1 && args[0] === 'schema') return comparison(status);
    if (args.includes('--execute')) return 'done\n';
    if (failPreview) throw new Error('Preview failed');
    return preview(args[0], status);
  };
  return { calls, run };
}
async function simulate(answers, status = 'ready', settings = {}) {
  const { calls, run } = runner(status, settings);
  await interactive({ ask: async () => answers.shift() ?? '', run, databases, print: () => {},
    proposeProcedures: noProcedures });
  return calls;
}
const execution = calls => calls.find(args => args.includes('--execute'));

test('menu compares the live databases first and cancellation never writes', async () => {
  const calls = await simulate(['7', '1,2,code:abc', '']);
  assert.deepEqual(calls[0], ['schema']);
  assert.deepEqual(calls[1], ['experiment-only', '--experiment-id', '1', '--experiment-id', '2', '--login-code', 'abc']);
  assert.equal(execution(calls), undefined);
});

test('Apply? y executes with explicit target and host; anything else cancels', async () => {
  const calls = await simulate(['2', 'y']);
  assert.deepEqual(execution(calls), ['all-data', '--execute', '--confirm-target', 'migration_target', '--confirm-host', 'test-host']);
  assert.deepEqual(calls.at(-1), ['schema']);
  for (const answer of ['', 'n', 'no', 'invalid']) assert.equal(execution(await simulate(['2', answer])), undefined);
  for (const answer of ['Y', 'yes', ' YES ']) assert.ok(execution(await simulate(['2', answer])));
});

test('differing schemas show the generated SQL and its reverse, and y applies exactly that SQL', async () => {
  const printed = [];
  const prompts = [];
  const { calls, run } = runner('different');
  const answers = ['1', 'y'];
  await interactive({ ask: async prompt => { prompts.push(prompt); return answers.shift() ?? ''; }, run, databases,
    print: line => printed.push(line), proposeProcedures: noProcedures });
  assert.ok(printed.includes(schemaChange.sql));
  assert.ok(printed.some(line => line.includes(schemaChange.reverseSql)));
  assert.deepEqual(execution(calls), ['schema', '--expect-change', SHA, '--execute',
    '--confirm-target', 'migration_target', '--confirm-host', 'test-host']);
  assert.deepEqual(prompts, ['Choose an option: ', 'Apply? [y/N]: ']);
});

test('every schema-inclusive choice migrates differing schemas with the previewed SQL', async () => {
  for (let index = 0; index < menu.length; index++) {
    const choice = menu[index][0];
    if (!requiresSchemaApply(choice)) continue;
    const answers = [String(index + 1)];
    if (choice.startsWith('one-experiment') || choice === 'experiment-only') answers.push('123');
    answers.push('y');
    const run = execution(await simulate(answers, 'different'));
    assert.equal(run[0], choice);
    assert.ok(run.includes(SHA));
  }
});

test('matching schemas make schema-only a no-op and need no SQL binding for content', async () => {
  assert.equal((await simulate(['1'])).length, 1);
  const calls = await simulate(['9', 'y']);
  assert.equal(execution(calls)[0], 'records-only');
  assert.ok(!execution(calls).includes('--expect-change'));
});

test('content-only choices refuse differing live schemas before any preview', async () => {
  for (const choice of ['records-only', 'procedures-only']) {
    const number = String(menu.findIndex(([value]) => value === choice) + 1);
    const { calls, run } = runner('different');
    await assert.rejects(interactive({ ask: async () => number, databases, print: () => {}, run }), /does not change schema/);
    assert.deepEqual(calls, [['schema']]);
  }
});

test('preview failure stops execution', async () => {
  await assert.rejects(simulate(['2'], 'ready', { failPreview: true }), /Preview failed/);
});

test('experiment selection supports all but validates IDs and single selections', () => {
  assert.deepEqual(selectionArgs('experiment-only', 'all'), ['experiment-only', '--all-experiments']);
  assert.throws(() => selectionArgs('one-experiment', '1,2'), /repeated/);
  assert.throws(() => selectionArgs('experiment-only', '0'), /positive/);
  assert.throws(() => selectionArgs('experiment-only', 'code:'), /empty/);
});

test('incomplete, failed or executed output blocks execution', () => {
  assert.throws(() => comparisonFromOutput('{}'), /incomplete/);
  assert.equal(comparisonFromOutput(comparison('different')).status, 'different');
  assert.equal(comparisonFromOutput(comparison()).status, 'ready');
  assert.throws(() => comparisonFromOutput(comparison('pending')), /did not pass/);
  assert.deepEqual(reportFromOutput(preview('schema', 'different')).schemaChange, schemaChange);
  assert.throws(() => reportFromOutput('no report'), /incomplete/);
  assert.throws(() => reportFromOutput(`${JSON.stringify({ choice: 'schema', executed: true })}\n`), /did not pass/);
});

test('all nine menu choices generate valid previews', async () => {
  assert.equal(menu.length, 9);
  for (let index = 1; index < menu.length; index++) {
    const choice = menu[index][0];
    const answers = [String(index + 1)];
    if (choice.startsWith('one-experiment') || choice === 'experiment-only') answers.push('123');
    answers.push('');
    const calls = await simulate(answers);
    assert.equal(calls[1][0], choice);
    assert.equal(execution(calls), undefined);
  }
});

test('exit is option ten and invalid menu numbers cannot execute', async () => {
  for (const number of ['10', '0', '']) assert.equal((await simulate([number])).length, 1);
  for (const number of ['11', '-1', '1.5', 'abc', '01']) {
    await assert.rejects(simulate([number]), /Choose a number/);
  }
});

test('a failed comparison offers recovery without attempting migration writes', async () => {
  let offered = false;
  await assert.rejects(interactive({
    ask: async () => 'y', run: async () => { throw new Error('Connection refused'); }, databases,
    offerRollback: async () => { offered = true; }, print: () => {},
  }), /Connection refused/);
  assert.equal(offered, true);
});

test('the menu R option opens rollback without running a migration', async () => {
  let opened = false;
  const { calls, run } = runner();
  await interactive({ ask: async () => 'r', databases, print: () => {}, run, openRollback: async () => { opened = true; } });
  assert.equal(opened, true);
  assert.deepEqual(calls, [['schema']]);
});

test('restore offer requires checkpoint selection, preview and separate y confirmation', async () => {
  const calls = [];
  const answers = ['2', '2', 'y'];
  await offerRollback({ ask: async () => answers.shift(), databases, print: () => {},
    run: async args => {
      calls.push(args);
      return JSON.stringify({ checkpoints: [
        { steps: 1, label: 'Before procedures', createdAt: 'today' },
        { steps: 2, label: 'Before data', createdAt: 'today' },
      ] });
    },
  });
  assert.deepEqual(calls[1], ['restore', '--steps', '2']);
  assert.deepEqual(calls[2], ['restore', '--steps', '2', '--execute',
    '--confirm-target', 'migration_target', '--confirm-host', 'test-host']);
});

const undoPreview = (settings = {}) => JSON.stringify({
  action: 'schema-down', executed: false, warning: 'Schema only.',
  changes: [{ id: '1791147653833-change', appliedAt: 'today', sql: 'ALTER TABLE study DROP x;\n' }], ...settings,
});

test('schema undo shows the reverse SQL and runs only after Apply? y', async () => {
  const calls = [];
  const printed = [];
  const answers = ['1', 'y'];
  await offerRollback({ ask: async () => answers.shift(), databases, print: line => printed.push(line),
    run: async args => { calls.push(args); return undoPreview(); } });
  assert.deepEqual(calls, [['down'], ['down', '--execute', '--confirm-target', 'migration_target', '--confirm-host', 'test-host']]);
  assert.ok(printed.includes('ALTER TABLE study DROP x;\n'));

  const declined = [];
  const no = ['1', 'n'];
  await offerRollback({ ask: async () => no.shift(), databases, print: () => {},
    run: async args => { declined.push(args); return undoPreview(); } });
  assert.deepEqual(declined, [['down']]);
});

test('unavailable or malformed schema undo never executes and points to checkpoints', async () => {
  for (const run of [
    async () => { throw new Error('No recorded schema changes'); },
    async () => undoPreview({ executed: true }),
    async () => undoPreview({ changes: [] }),
  ]) {
    const calls = [];
    const printed = [];
    const answers = ['1', 'y'];
    await offerRollback({ ask: async () => answers.shift(), databases, print: line => printed.push(line),
      run: async args => { calls.push(args); return run(); } });
    assert.deepEqual(calls, [['down']]);
    assert.ok(printed.some(line => /unavailable|incomplete/.test(line)));
  }
});

test('procedure approval precedes the single Apply? prompt and never asks for passwords', async () => {
  for (const choice of ['stored-procedures', 'one-experiment-with-procedures', 'all', 'procedures-only']) {
    const answers = [String(menu.findIndex(([value]) => value === choice) + 1)];
    if (choice.startsWith('one-experiment')) answers.push('42');
    answers.push('y', 'y');
    const events = [];
    const prompts = [];
    const proposal = { plan: { definer: { user: 'admin', host: '%' },
      pending: [{ name: 'example', sql: 'CREATE PROCEDURE example() SELECT 1', sqlMode: '' }] } };
    const { run } = runner(choice === 'procedures-only' ? 'ready' : 'different');
    await interactive({ databases, print: () => {},
      ask: async prompt => { prompts.push(prompt); return answers.shift() ?? ''; },
      run: async args => { events.push(args); return run(args); },
      proposeProcedures: async () => { events.push('procedure-preview'); return proposal; },
      approveProcedures: async value => { assert.equal(value, proposal); events.push('procedure-approved'); },
    });
    const write = events.findIndex(value => Array.isArray(value) && value.includes('--execute'));
    assert.ok(write > events.indexOf('procedure-approved'));
    assert.equal(events[write][0], choice);
    assert.ok(prompts.some(prompt => /stored procedures.*target account.*\[y\/N\]/.test(prompt)));
    assert.equal(prompts.at(-1), 'Apply? [y/N]: ');
    assert.ok(prompts.every(prompt => !/password/i.test(prompt)));
    assert.equal(answers.length, 0);
  }
});

test('declining procedures keeps only explicitly confirmed non-procedure scope, or cancels procedures-only', async () => {
  for (const [choice, fallback] of [['all', 'all-data'], ['stored-procedures', 'schema'],
    ['one-experiment-with-procedures', 'one-experiment'], ['procedures-only', undefined]]) {
    const answers = [String(menu.findIndex(([value]) => value === choice) + 1)];
    if (choice.startsWith('one-experiment')) answers.push('42');
    answers.push('n', 'y');
    const { calls, run } = runner(choice === 'procedures-only' ? 'ready' : 'different');
    await interactive({ databases, print: () => {}, ask: async () => answers.shift() ?? '', run,
      proposeProcedures: async () => ({ plan: { definer: { user: 'admin', host: '%' },
        pending: [{ name: 'example', sql: 'CREATE PROCEDURE example() SELECT 1', sqlMode: '' }] } }),
      approveProcedures: async () => { throw new Error('Declined procedures must not be approved'); },
    });
    assert.equal(execution(calls)?.[0], fallback);
    if (fallback === 'one-experiment') assert.ok(execution(calls).includes('42'));
    if (!fallback) assert.deepEqual(calls, [['schema']]);
  }
});

test('failed procedure approval cannot reach the schema preview or any database writes', async () => {
  const answers = ['6', 'y'];
  const { calls, run } = runner('different');
  await assert.rejects(interactive({ databases, print: () => {}, ask: async () => answers.shift(), run,
    proposeProcedures: async () => ({ plan: { definer: { user: 'admin', host: '%' },
      pending: [{ name: 'example', sql: 'CREATE PROCEDURE example() SELECT 1', sqlMode: '' }] } }),
    approveProcedures: async () => { throw new Error('Live definition changed'); },
  }), /Live definition changed/);
  assert.deepEqual(calls, [['schema']]);
});


test('rollback labels describe the saved state and preserve unknown labels', async () => {
  const { rollbackLabel } = await import('../rollback-labels.mjs');
  assert.equal(rollbackLabel('Before content stage stored-procedures'), 'Before stored procedures');
  assert.equal(rollbackLabel('Before schema change abc123'), 'Before schema changes');
  assert.equal(rollbackLabel('Before content stage all-data'), 'Before records');
  assert.equal(rollbackLabel('Before manual repair'), 'Before manual repair');
});
