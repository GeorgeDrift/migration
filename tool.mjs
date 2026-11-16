import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { databaseConfigs, passwordFor, readCa, sslFor } from './database-config.mjs';
import { inspectSchemaStage } from './schema-stage.mjs';
import { contentStages, migrationSummary, parseWorkflowArgs, requiresSchemaApply } from './workflow-options.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRecovery, targetIdentity } from './recovery.mjs';
import { generateReviewedChange, applyReviewedChange } from './reviewed-migrate.mjs';
import { loadMigrations, pendingMigrations, assertAllowedSelection } from './migration-policy.mjs';
import { readRevisions } from './schema-stage.mjs';
import { newChangeId, saveChange } from './schema-changes.mjs';
import { performance } from 'node:perf_hooks';

function child(script, args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: new URL('.', import.meta.url),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error || result.status !== 0) {
    if (capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${script} failed (${result.error?.message || result.status}).`);
  }
  if (capture && result.stdout) process.stdout.write(result.stdout);
  if (capture && result.stderr) process.stderr.write(result.stderr);
}

function connection(config, ca) {
  return mysql.createConnection({
    host: config.host, port: config.port, database: config.schema, user: config.user,
    password: passwordFor(config), ssl: sslFor(config, ca),
    connectTimeout: 15000, supportBigNumbers: true, bigNumberStrings: true,
  });
}

async function schemaPlan(databases, ca) {
  const connections = [];
  try {
    connections.push(await connection(databases.dev, ca));
    connections.push(await connection(databases.target, ca));
    const schema = await inspectSchemaStage(connections[0], connections[1], databases);
    const pending = pendingMigrations(loadMigrations(), await readRevisions(connections[1], databases.target.schema));
    return { ...schema, status: pending.length ? 'different' : schema.status,
      pendingMigrations: pending.map(migration => migration.name) };
  } finally {
    await Promise.allSettled(connections.map(connection => connection.end()));
  }
}

function contentArguments(stage, options) {
  const args = stage === 'one-experiment'
    ? (options.allExperiments ? ['--all-experiments']
      : [...options.experimentIds.flatMap(id => ['--experiment-id', String(id)]),
        ...options.loginCodes.flatMap(code => ['--login-code', code])]) : [];
  if (options.execute) {
    args.push('--execute', '--confirm-target', options.confirmTarget,
      '--confirm-host', options.confirmHost);
  } else if (options.strictPreview && stage !== 'one-experiment') {
    args.push('--strict-preview');
  }
  return args;
}

// The guided CloudShell run reprints this file as its final message, after the read-only comparison.
function saveSummaryFile(text) {
  if (process.env.MIGRATION_SUMMARY_FILE) writeFileSync(process.env.MIGRATION_SUMMARY_FILE, `${text}
`);
}

async function main() {
  const options = parseWorkflowArgs(process.argv.slice(2));
  const databases = databaseConfigs();
  if (options.execute && (options.confirmTarget !== databases.target.schema
      || options.confirmHost !== databases.target.host)) {
    throw new Error(`Confirm target ${databases.target.schema} and host ${databases.target.host}.`);
  }
  if (passwordFor(databases.dev) === undefined || passwordFor(databases.target) === undefined
     ) {
    throw new Error('Set source and target database passwords.');
  }
  const ca = readCa();
  return runWorkflow(options, databases, ca);
}

async function applyLiveChange(databases, ca, change, recovery, options) {
  return applyReviewedChange(databases, ca, change, recovery, options, child);
}

// Rollback reads this record: the SQL that ran, its reverse, and the schema before and after.
function recordLiveChange(change, states, checkpoint, databases, recovery) {
  return saveChange(recovery.root, {
    id: newChangeId(), createdAt: new Date().toISOString(),
    target: targetIdentity(databases.target), source: targetIdentity(databases.dev),
    checkpoint: checkpoint.id, sha256: change.sha256, sql: change.sql,
    mode: change.mode ?? 'legacy',
    ...(change.reverseSql ? { reverseSql: change.reverseSql } : {}),
    schemaBefore: states.before, schemaAfter: states.after,
  });
}

export async function runWorkflow(options, databases, ca, {
  inspect = schemaPlan, runChild = child, print = console.log,
  openRecovery = createRecovery, clock = () => performance.now(),
  generate = generateReviewedChange, applyChange = applyLiveChange, recordChange = recordLiveChange,
  saveSummary = saveSummaryFile,
} = {}) {
  if (options.execute && (options.confirmTarget !== databases.target.schema
      || options.confirmHost !== databases.target.host)) {
    throw new Error(`Confirm target ${databases.target.schema} and host ${databases.target.host}.`);
  }
  const report = {
    choice: options.choice,
    source: { host: databases.dev.host, port: databases.dev.port, schema: databases.dev.schema },
    target: { host: databases.target.host, port: databases.target.port, schema: databases.target.schema },
    executed: false,
    completedStages: [],
    timingsMs: {},
  };
  async function measure(phase, action) {
    const start = clock();
    try { return await action(); }
    finally { report.timingsMs[phase] = (report.timingsMs[phase] || 0) + Math.max(0, clock() - start); }
  }
  const measuredChild = (script, args, settings) => measure(
    !args.includes('--execute') ? 'comparison'
      : script === 'run.mjs' ? 'schema' : script === 'copy-procedures.mjs' ? 'procedures' : 'records',
    () => runChild(script, args, settings),
  );
  async function openMeasuredRecovery() {
    const session = await measure('lockAndPreflight', () => openRecovery(databases, ca, { print }));
    return { ...session,
      checkpoint: (...args) => measure('backup', () => session.checkpoint(...args)),
      restore: (...args) => measure('restore', () => session.restore(...args)),
      get first() { return session.first; }, get last() { return session.last; },
    };
  }
  // Previews print nothing extra: interactive.mjs parses their final JSON line.
  function summarize(final) {
    if (!options.execute) return;
    const text = migrationSummary(options, final);
    print(text);
    try { saveSummary(text); } catch (error) { print(`Migration result not saved for the final message (${error.message}).`); }
  }
  let recovery;
  try {
    const schema = await measure('comparison', () => inspect(databases, ca));
    print(JSON.stringify({ stage: 'schema', ...schema }, null, 2));
    if (!requiresSchemaApply(options.choice) && schema.status !== 'ready') {
      throw new Error(`${options.choice} does not change schema, and the live target schema differs from the source. Choose a schema-inclusive option first.`);
    }
    // These checks do not need target tables; fail before any schema change if procedures are not ready.
    if (options.execute && options.withProcedures && schema.status === 'different') {
      print('Checking stored procedures before any schema writes (read-only)...');
      await measuredChild('copy-procedures.mjs', ['--strict-preview'], { capture: true });
    }
    if (schema.status === 'different') {
      const change = await measure('comparison', () => generate());
      if (change.mode === 'reviewed' && !change.migrations.length) {
        throw new Error('Schema drift has no pending reviewed migration. Generate a diff, review and register SQL before deployment.');
      }
      report.schemaChange = { sha256: change.sha256, statements: change.statements.length, sql: change.sql,
        ...(change.mode ? { mode: change.mode, risk: change.risk,
          migrations: change.migrations.map(migration => migration.name) } : {}),
        ...(change.reverseSql ? { reverseSql: change.reverseSql } : {}) };
      if (!options.execute) {
        const preview = { ...report, deferredContentStages: contentStages(options),
          next: 'Review the schema SQL. Applying saves a checkpoint of the target, runs the SQL, verifies the target matches the source and records the change for rollback.' };
        print(JSON.stringify(preview));
        return preview;
      }
      if (options.expectChange !== change.sha256) {
        throw new Error(options.expectChange
          ? 'The live difference changed since the preview; nothing was applied. Preview again.'
          : 'Applying schema changes requires --expect-change with the SHA-256 shown in the preview.');
      }
      if (change.mode === 'reviewed') assertAllowedSelection(change.migrations, { ...options, action: 'apply' });
      recovery = await openMeasuredRecovery();
      const checkpoint = await recovery.checkpoint(`Before schema change ${change.sha256.slice(0, 12)}`);
      report.writeAttempted = true;
      const states = await measure('schema', () => applyChange(databases, ca, change, recovery, options));
      report.executed = true;
      const after = await measure('verification', () => inspect(databases, ca));
      if (after.status !== 'ready') {
        throw new Error(`The target still differs from the source after the schema change: ${after.differences.join(', ')}.`);
      }
      report.completedStages.push('schema-change');
      // The record only serves rollback; migration never depends on it.
      try {
        const record = await recordChange(change, states, checkpoint, databases, recovery);
        report.schemaChange.record = record.id;
      } catch (error) {
        report.schemaChange.recordWarning = `Rollback record not saved (${error.message}). Roll back with checkpoint ${checkpoint.id} instead.`;
        print(report.schemaChange.recordWarning);
      }
      print(JSON.stringify({ stage: 'schema', applied: change.sha256, record: report.schemaChange.record ?? null }));
      report.completedStages.push('schema-verified');
    } else {
      report.completedStages.push('schema-verified');
    }
    const scripts = {
        'all-data': 'copy-data.mjs',
        'one-experiment': 'one-experiment.mjs',
        'stored-procedures': 'copy-procedures.mjs',
    };
    const stages = contentStages(options);
    // Fresh read-only content previews happen after target schema is ready.
    for (const stage of stages) {
      print(`Previewing ${stage} against the verified target schema (read-only)...`);
      await measuredChild(scripts[stage], contentArguments(stage, { ...options, execute: false, strictPreview: true }), { capture: true });
    }
    if (options.execute) {
      if (stages.length && !recovery) recovery = await openMeasuredRecovery();
      for (const stage of stages) {
        await recovery.checkpoint(`Before content stage ${stage}`);
        report.writeAttempted = true;
        await measuredChild(scripts[stage], contentArguments(stage, options), { capture: true });
        report.executed = true;
        report.completedStages.push(stage);
      }
    }
    if (options.execute && report.writeAttempted) {
      const finalSchema = await measure('verification', () => inspect(databases, ca));
      if (finalSchema.status !== 'ready') throw new Error('Final schema verification failed; recovery is required.');
    }
    const result = { ...report, next: options.execute ? 'Complete.' : 'Review this preview before execution.' };
    print(JSON.stringify(result));
    summarize(result);
    return result;
  } catch (error) {
    if (recovery?.first && report.writeAttempted) {
      try {
        const checkpoint = await recovery.restore(recovery.first);
        report.rollback = { status: 'verified', checkpoint: checkpoint.id, scope: 'entire attempted workflow' };
        report.revertedStages = [...report.completedStages];
        report.completedStages = [];
        report.executed = false;
      } catch (restoreError) {
        report.rollback = { status: 'failed', checkpoint: recovery.first.id, error: restoreError.message };
      }
    }
    const failed = { ...report, failed: error.message,
      next: 'Inspect committed stages and run a fresh preview before retrying.' };
    print(JSON.stringify(failed));
    summarize(failed);
    throw error;
  } finally {
    if (recovery) await recovery.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
