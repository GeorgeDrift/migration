import { rollbackLabel } from './rollback-labels.mjs';
import { createInterface } from 'node:readline/promises';
import { offerCheckpointRestore } from './interactive.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { databaseConfigs, passwordFor, readCa, sslFor } from './database-config.mjs';
import { createRecovery, listCheckpoints, recoveryDirectory, selectCheckpoint } from './recovery.mjs';
import { compareSchemaState, readSchemaState } from './schema-rollback.mjs';
import { listChanges, markUndone } from './schema-changes.mjs';
import { splitStatements } from './numeric-fidelity.mjs';
import { reviewedDown } from './reviewed-down.mjs';

const usage = 'Usage: node rollback.mjs list | restore [--steps 1|2|3] | down [--steps N]'
  + ' [--allow-destructive] [--execute --confirm-target NAME --confirm-host HOST]';

export function parseRollbackArgs(args) {
  const [action, ...flags] = args;
  if (!['list', 'restore', 'down'].includes(action)) throw new Error(usage);
  const options = { action, steps: 1, execute: false };
  const seen = new Set();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (seen.has(flag)) throw new Error(`Repeated rollback flag: ${flag}`);
    seen.add(flag);
    if (flag === '--execute') options.execute = true;
    else if (flag === '--allow-destructive' && action === 'down') options.allowDestructive = true;
    else if (['--steps', '--confirm-target', '--confirm-host'].includes(flag) && flags[index + 1]) {
      const value = flags[++index];
      if (flag === '--steps') {
        if (action === 'down') {
          if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
            throw new Error('Undo steps must be a positive integer.');
          }
        } else if (!/^[1-3]$/.test(value)) throw new Error('Rollback steps must be 1, 2, or 3.');
        options.steps = Number(value);
      } else options[flag === '--confirm-target' ? 'confirmTarget' : 'confirmHost'] = value;
    } else throw new Error(`Unknown rollback flag: ${flag}`);
  }
  if (action === 'list' && flags.length) throw new Error('Listing checkpoints is read-only and accepts no flags.');
  if (!options.execute && (options.confirmTarget || options.confirmHost)) throw new Error('Confirmation requires --execute.');
  if (options.execute && (!options.confirmTarget || !options.confirmHost)) throw new Error('Rollback writes require target and host confirmation.');
  return options;
}

// Undo of applied schema changes, newest first, using their recorded reverse SQL.
// A checkpoint snapshot of the target is always saved first and restored if anything fails.
export async function schemaDown(options, databases, {
  env = process.env, connect = mysql.createConnection, open = createRecovery, print = console.log,
  clock = () => performance.now(), spawn,
} = {}) {
  const started = clock();
  const target = databases.target;
  const password = passwordFor(target, env);
  if (password === undefined) throw new Error('Set the target database password.');
  if (options.execute && (options.confirmTarget !== target.schema || options.confirmHost !== target.host)) {
    throw new Error('Schema undo confirmation does not match the configured target.');
  }
  const root = recoveryDirectory(env);
  const changes = listChanges(root, target);
  if (!changes.length) {
    throw new Error('No recorded schema changes exist for this target. Use "npm run rollback -- restore" to return to a saved checkpoint.');
  }
  if (options.steps > changes.length) {
    throw new Error(`Only ${changes.length} recorded schema change(s) can be undone for this target.`);
  }
  const selected = changes.slice(0, options.steps);
  const missing = selected.find(change => !change.reverseSql);
  if (missing) {
    throw new Error(`Schema change ${missing.id} has no reverse SQL. Restore the checkpoint taken before it (${missing.checkpoint}) with "npm run rollback -- restore".`);
  }
  const ca = readCa(env);
  const db = await connect({
    host: target.host, port: target.port, database: target.schema, user: target.user,
    password, ssl: sslFor(target, ca), connectTimeout: 15000,
  });
  const describe = differences => differences.map(item => `${item.table} (${item.fields.join(', ')})`).join('; ');
  let recovery;
  try {
    const drift = compareSchemaState(selected[0].schemaAfter, await readSchemaState(db, target.schema));
    if (drift.length) {
      throw new Error(`The target changed after schema change ${selected[0].id}: ${describe(drift)}. Undoing it could damage newer changes; restore a checkpoint instead.`);
    }
    const preview = {
      action: 'schema-down', executed: false, target: target.schema, host: target.host, steps: options.steps,
      changes: selected.map(change => ({
        id: change.id, appliedAt: change.createdAt, checkpointBeforeChange: change.checkpoint,
        statements: splitStatements(change.reverseSql).length, sql: change.reverseSql,
      })),
      warning: 'Schema only: records are not restored, and data in columns or tables dropped by this SQL is lost. A checkpoint snapshot of the target is saved first.',
    };
    if (!options.execute) {
      print(JSON.stringify(preview, null, 2));
      return preview;
    }
    recovery = await open(databases, ca, { env, print });
    const checkpoint = await recovery.checkpoint(`Before undoing schema change(s) ${selected.map(change => change.id).join(', ')}`);
    try {
      for (const change of selected) {
        await recovery.assertSafe();
        const current = compareSchemaState(change.schemaAfter, await readSchemaState(db, target.schema));
        if (current.length) throw new Error(`The target does not match the state left by schema change ${change.id}: ${describe(current)}.`);
        for (const statement of splitStatements(change.reverseSql)) {
          await recovery.assertSafe();
          await db.query(statement);
        }
        const restored = compareSchemaState(change.schemaBefore, await readSchemaState(db, target.schema));
        if (restored.length) throw new Error(`After undoing ${change.id} the schema differs from before that change: ${describe(restored)}.`);
        print(JSON.stringify({ undoneChange: change.id }));
      }
    } catch (error) {
      try {
        await recovery.restore(checkpoint);
        error.message += ` The target was restored to checkpoint ${checkpoint.id} taken before this undo.`;
      } catch (restoreError) {
        error.message += ` Automatic restore failed (${restoreError.message}); restore checkpoint ${checkpoint.id} manually.`;
      }
      throw error;
    }
    const warnings = [];
    for (const change of selected) {
      try { markUndone(root, change.id, { checkpoint: checkpoint.id }, { env, ...(spawn ? { spawn } : {}) }); }
      catch (error) { warnings.push(`${change.id}: ${error.message}`); }
    }
    const result = {
      action: 'schema-down', executed: true, target: target.schema, host: target.host,
      undone: selected.map(change => change.id), checkpoint: checkpoint.id, verified: 'schema-before-change',
      ...(warnings.length ? { recordWarnings: warnings } : {}),
      elapsedMs: Math.round(clock() - started),
    };
    print(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await db.end().catch(() => {});
    if (recovery) await recovery.close();
  }
}

export async function rollback(args, { print = console.log, open = createRecovery } = {}) {
  const options = parseRollbackArgs(args);
  const databases = databaseConfigs();
  if (options.action === 'down') {
    const reviewed = await reviewedDown(options, databases, { print, open });
    return reviewed ?? schemaDown(options, databases, { print, open });
  }
  const root = recoveryDirectory();
  const checkpoints = listCheckpoints(root, databases);
  if (options.action === 'list') {
    print(JSON.stringify({ target: databases.target.schema, checkpoints: checkpoints.slice(0, 3).map((record, index) => ({
      steps: index + 1, id: record.id, label: rollbackLabel(record.label), createdAt: record.createdAt,
    })) }, null, 2));
    return;
  }
  const selected = selectCheckpoint(checkpoints, options.steps);
  if (!options.execute) {
    print(JSON.stringify({ action: 'restore-preview', executed: false, steps: options.steps,
      checkpoint: selected.id, label: rollbackLabel(selected.label), target: selected.target,
      warning: 'Restore replaces the whole target database, including records, procedures and Atlas history. Pause all target writers.' }, null, 2));
    return;
  }
  if (options.confirmTarget !== databases.target.schema || options.confirmHost !== databases.target.host) {
    throw new Error('Restore confirmation does not match the configured target.');
  }
  const recovery = await open(databases, readCa());
  try { await recovery.restore(selected); }
  finally { await recovery.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const action = args.length === 1 && args[0] === 'menu' ? async () => {
    if (!process.stdin.isTTY) throw new Error('Use an interactive PowerShell terminal for the rollback menu.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await offerCheckpointRestore({ ask: prompt => rl.question(prompt), databases: databaseConfigs(),
        run: async flags => {
          const lines = [];
          await rollback(flags, { print: line => { lines.push(line); if (flags[0] !== 'list') console.log(line); } });
          return lines.join('\n');
        } });
    } finally { rl.close(); }
  } : () => rollback(args);
  action().catch(error => { console.error(error.message); process.exitCode = 1; });
}
