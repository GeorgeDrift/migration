import { rollbackLabel } from './rollback-labels.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { databaseConfigs } from './database-config.mjs';
import { parseWorkflowArgs, requiresSchemaApply } from './workflow-options.mjs';
import { proposeProcedureReview, approveProcedureReview } from './procedure-review.mjs';

export const menu = [
  ['schema', 'Schema only'], ['all-data', 'Schema + all records'],
  ['stored-procedures', 'Schema + stored procedures'],
  ['one-experiment', 'Schema + one experiment'],
  ['one-experiment-with-procedures', 'Schema + one experiment + procedures'],
  ['all', 'Schema + all records + procedures'],
  ['experiment-only', 'Selected or all experiments (prepare schema first)'],
  ['procedures-only', 'Stored procedures only (no schema or records)'],
  ['records-only', 'Records only (no schema or procedures)'],
];

export function selectionArgs(choice, selection) {
  const args = [choice];
  if (choice === 'experiment-only' && selection.trim().toLowerCase() === 'all') {
    args.push('--all-experiments');
  } else if (['one-experiment', 'one-experiment-with-procedures', 'experiment-only'].includes(choice)) {
    for (const value of selection.split(',').map(value => value.trim()).filter(Boolean)) {
      if (choice === 'experiment-only' && value.startsWith('code:')) {
        args.push('--login-code', value.slice(5));
      } else args.push('--experiment-id', value);
    }
  }
  parseWorkflowArgs(args);
  return args;
}

export function comparisonFromOutput(output) {
  // The schema command prints a stage object followed by a final report line.
  const boundary = output.lastIndexOf('\n{"choice":');
  if (boundary < 0) throw new Error('Comparison output was incomplete; execution is disabled.');
  const stage = JSON.parse(output.slice(0, boundary).trim());
  const report = JSON.parse(output.slice(boundary).trim());
  if (stage.stage !== 'schema' || report.failed || report.executed !== false
      || !['ready', 'different'].includes(stage.status) || !Array.isArray(stage.differences)) {
    throw new Error('Comparison did not pass; execution is disabled.');
  }
  return stage;
}

export function reportFromOutput(output) {
  const boundary = output.lastIndexOf('\n{"choice":');
  const start = boundary >= 0 ? boundary : output.startsWith('{"choice":') ? 0 : -1;
  if (start < 0) throw new Error('Preview output was incomplete; execution is disabled.');
  const report = JSON.parse(output.slice(start).trim());
  if (report.failed || report.executed !== false) throw new Error('Preview did not pass; execution is disabled.');
  return report;
}

// Migration compares the two live databases: preview the difference, then one Apply? [y/N].
async function migrationMenu({ ask, run, databases, print = console.log,
  proposeProcedures = proposeProcedureReview, approveProcedures = approveProcedureReview, openRollback }) {
  print('Comparing source and target (read-only)...');
  const comparison = comparisonFromOutput(await run(['schema']));
  print(comparison.status === 'ready' ? 'The target schema matches the source.'
    : `Live schema differences in: ${comparison.differences.join(', ')}.`);
  menu.forEach(([choice, label], index) => print(`${index + 1}. ${label} (${choice})`));
  const exitNumber = menu.length + 1;
  print(`${exitNumber}. Exit`);
  if (openRollback) print('R. Roll back the target (undo the last schema change or restore a checkpoint)');
  const number = (await ask('Choose an option: ')).trim();
  if (number === '0' || number === String(exitNumber) || !number) return;
  if (openRollback && number.toLowerCase() === 'r') return openRollback();
  if (!/^[1-9]\d*$/.test(number) || Number(number) > menu.length) {
    throw new Error(`Choose a number from 1 to ${menu.length}, or ${exitNumber} to exit.`);
  }
  let choice = menu[Number(number) - 1][0];
  if (!requiresSchemaApply(choice)) {
    if (comparison.status !== 'ready') {
      throw new Error(`${choice} does not change schema, and the live schemas differ. Use a schema-inclusive choice first.`);
    }
    print('This choice changes only the selected content; table schema will not be altered.');
  }
  let selection = '';
  if (choice === 'experiment-only') {
    selection = await ask('Enter comma-separated IDs or code:LOGIN_CODE values, or all: ');
  } else if (choice.startsWith('one-experiment')) {
    selection = await ask('Enter one experiment ID: ');
  }
  let args = selectionArgs(choice, selection);
  if (parseWorkflowArgs(args).withProcedures) {
    const proposal = await proposeProcedures(databases);
    const { plan } = proposal;
    print(`Procedure account: ${plan.definer.user}@${plan.definer.host} on the target.`);
    print('No additional password is needed. The existing target connection is used.');
    print('Procedures retain their SQL SECURITY setting. DEFINER routines run with this account\'s permissions; use a least-privilege target account in production.');
    for (const item of plan.pending) {
      print(`${item.name} (SQL mode: ${item.sqlMode || '(empty)'}):\n${item.sql}`);
    }
    if (plan.pending.length) {
      const answer = (await ask(`Copy these ${plan.pending.length} stored procedures using this target account? [y/N]: `)).trim().toLowerCase();
      if (!['y', 'yes'].includes(answer)) {
        if (choice === 'procedures-only') {
          print('Cancelled. No procedure migration was requested.');
          return;
        }
        choice = { all: 'all-data', 'stored-procedures': 'schema',
          'one-experiment-with-procedures': 'one-experiment' }[choice];
        args = selectionArgs(choice, selection);
        print(`Stored procedures skipped. Continue with ${choice}; execution still requires confirmation.`);
      } else {
        await approveProcedures(proposal, databases);
        print('Procedure definitions approved. No database changes have been made.');
      }
    } else {
      print('Stored procedures already match; no procedure changes are needed.');
    }
  }
  if (choice === 'schema' && comparison.status === 'ready') {
    print('Schema matches; nothing to migrate.');
    return;
  }
  print('Preview (read-only):');
  const preview = reportFromOutput(await run(args));
  if (preview.schemaChange) {
    print(`Schema SQL that makes ${databases.target.schema} match the source:`);
    print(preview.schemaChange.sql);
    print(preview.schemaChange.reverseSql
      ? `Reverse SQL kept for rollback:\n${preview.schemaChange.reverseSql}`
      : 'No reverse SQL could be generated; rolling this change back will use the checkpoint snapshot.');
    print('Columns or tables removed by this SQL lose their data. A checkpoint snapshot of the target is saved first.');
    args = [...args, '--expect-change', preview.schemaChange.sha256];
    if (preview.schemaChange.risk === 'destructive') {
      if (!['y', 'yes'].includes((await ask('Approve this reviewed destructive migration? [y/N]: ')).trim().toLowerCase())) return;
      args.push('--allow-destructive');
    }
  }
  print(`Migration: ${choice}`);
  print(`Target database: ${databases.target.schema}`);
  print(`Target host: ${databases.target.host}`);
  if (!['y', 'yes'].includes((await ask('Apply? [y/N]: ')).trim().toLowerCase())) {
    print('Cancelled. Nothing was changed.');
    return;
  }
  await run([...args, '--execute', '--confirm-target', databases.target.schema,
    '--confirm-host', databases.target.host]);
  print('Comparing source and target again after the migration...');
  await run(['schema']);
}

export async function interactive(options) {
  try { return await migrationMenu(options); }
  catch (error) {
    if (options.offerRollback) await options.offerRollback(error);
    throw error;
  }
}

const confirmed = answer => ['y', 'yes'].includes(answer.trim().toLowerCase());

export async function offerRollback({ ask, run, databases, print = console.log }) {
  print('Rollback options:');
  print('1. Undo the last schema change with its reverse SQL (schema only; a checkpoint snapshot is saved first)');
  print('2. Restore a saved full checkpoint (slow, replaces the whole database)');
  const mode = (await ask('Choose 1 or 2 (Enter cancels): ')).trim();
  if (mode === '1') return offerSchemaUndo({ ask, run, databases, print });
  if (mode === '2') return offerCheckpointRestore({ ask, run, databases, print });
  if (mode) print('Unknown choice. No rollback requested.');
}

export async function offerSchemaUndo({ ask, run, databases, print = console.log }) {
  let preview;
  try { preview = JSON.parse(await run(['down'])); }
  catch (error) {
    print(`Fast schema undo is unavailable: ${error.message}`);
    print('Choose the saved checkpoint restore instead.');
    return;
  }
  if (preview.action !== 'schema-down' || preview.executed !== false || !preview.changes?.length) {
    print('Schema undo preview was incomplete. No undo requested.'); return;
  }
  for (const change of preview.changes) {
    print(`Undo schema change ${change.id} (applied ${change.appliedAt}) on ${databases.target.schema} (${databases.target.host}):`);
    print(change.sql);
  }
  print(preview.warning);
  if (!confirmed(await ask('Apply? [y/N]: '))) { print('Cancelled. No undo requested.'); return; }
  await run(['down', ...(preview.requiresAllowDestructive ? ['--allow-destructive'] : []), '--execute', '--confirm-target', databases.target.schema,
    '--confirm-host', databases.target.host]);
}

export async function offerCheckpointRestore({ ask, run, databases, print = console.log }) {
  let checkpoints;
  try { checkpoints = JSON.parse(await run(['list'])).checkpoints; }
  catch (error) { print(`Recovery checkpoints could not be listed: ${error.message}`); return; }
  if (!checkpoints.length) { print('No saved checkpoints exist. No historical state can be reconstructed.'); return; }
  print('Choose the previous state to restore:');
  for (const checkpoint of checkpoints) print(`${checkpoint.steps}. ${rollbackLabel(checkpoint.label)} (${checkpoint.createdAt})`);
  const steps = (await ask('Choose a previous state by number (Enter cancels): ')).trim();
  if (!steps) return;
  if (!/^[1-3]$/.test(steps) || !checkpoints.some(checkpoint => checkpoint.steps === Number(steps))) {
    print('That checkpoint is unavailable. No restore requested.'); return;
  }
  await run(['restore', '--steps', steps]);
  print(`Restore to: ${rollbackLabel(checkpoints.find(checkpoint => checkpoint.steps === Number(steps)).label)}`);
  print(`Restore replaces the whole target ${databases.target.schema} on ${databases.target.host}. Pause all target writers.`);
  if (!['y', 'yes'].includes((await ask('Confirm restore? [y/N]: ')).trim().toLowerCase())) return;
  await run(['restore', '--steps', steps, '--execute', '--confirm-target', databases.target.schema,
    '--confirm-host', databases.target.host]);
}

function runScript(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: new URL('.', import.meta.url), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve(output)
      : reject(new Error(`Migration command failed (${signal || code}). Stop and inspect before retrying.`)));
  });
}

const runTool = args => runScript('tool.mjs', args);

async function main() {
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal for the migration menu.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = prompt => rl.question(prompt);
    const databases = databaseConfigs();
    const rollbackMenu = async () => {
      try { await offerRollback({ ask, databases, run: args => runScript('rollback.mjs', args) }); }
      catch (error) { console.error(`Rollback did not complete: ${error.message}`); }
    };
    await interactive({ ask, run: runTool, databases, offerRollback: rollbackMenu, openRollback: rollbackMenu });
  } finally { rl.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
