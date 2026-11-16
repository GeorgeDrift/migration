import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import mysql from 'mysql2/promise';
import { parseArgs } from './cli.mjs';
import { databaseConfigs, localOnly, passwordFor, readCa, sslFor } from './database-config.mjs';
import { assertAllowedSelection, loadMigrations, pendingMigrations } from './migration-policy.mjs';
import { readNumericSource } from './numeric-fidelity.mjs';
import { isEmptyTarget, validateNumericSelection } from './fresh-replay.mjs';
import { assertRecoveryLease, recoveryDirectory } from './recovery.mjs';
import { saveSchemaSnapshot } from './schema-rollback.mjs';

function databaseUrl(config, password, caPath) {
  const url = new URL(`maria://${config.host}:${config.port}/${config.schema}`);
  url.username = config.user;
  url.password = password;
  if (caPath) {
    url.searchParams.set('tls', 'true');
    url.searchParams.set('ssl-ca', caPath);
  }
  return url.toString();
}

async function selectedMigrations(config, password, ca, options) {
  const migrations = loadMigrations();
  if (migrations.length === 0) {
    throw new Error('No reviewed Fabla schema migrations exist. Preview the schema diff and review a versioned SQL file first.');
  }
  const connection = await mysql.createConnection({
    host: config.host, port: config.port, database: config.schema, user: config.user,
    password, ssl: sslFor(config, ca), connectTimeout: 15000,
  });
  try {
    const [revisionTable] = await connection.execute(
      'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [config.schema, 'atlas_schema_revisions'],
    );
    if (options.allowDirty && revisionTable.length) {
      throw new Error('--allow-dirty is only for an initial migration without Atlas revision history.');
    }
    const [revisions] = revisionTable.length
      ? await connection.query('SELECT version, applied, total, error FROM atlas_schema_revisions ORDER BY version')
      : [[]];
    const pending = pendingMigrations(migrations, revisions);
    const selected = pending.slice(0, Number(options.count));
    if (selected.length === 0) throw new Error('No pending reviewed schema migrations.');
    assertAllowedSelection(selected, options);
    if (options.execute && !selected[0].partial) {
      // Lets a later fast schema undo prove it restored this exact pre-migration schema.
      await saveSchemaSnapshot(connection, config, recoveryDirectory(), selected[0].version);
    }
    return { selected, pending, hasRevisionHistory: revisionTable.length > 0,
      emptyTarget: !revisionTable.length && await isEmptyTarget(connection, config.schema) };
  } finally {
    await connection.end();
  }
}

function runAtlas(args, config, password, caPath) {
  const started = performance.now();
  const result = spawnSync(process.env.ATLAS_BIN || 'atlas', args, {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ATLAS_DATABASE_URL: databaseUrl(config, password, caPath) },
  });
  const redact = value => !password ? (value || '') : (value || '').replaceAll(password, '[REDACTED]')
    .replaceAll(encodeURIComponent(password), '[REDACTED]');
  if (result.stdout) process.stdout.write(redact(result.stdout));
  if (result.stderr) process.stderr.write(redact(result.stderr));
  if (result.error || result.status !== 0) {
    throw new Error(`Atlas failed (${result.error?.message || result.status}). Inspect schema and revision history before retrying.`);
  }
  return Math.round(performance.now() - started);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = databaseConfigs()[options.database];
  const password = passwordFor(config);
  if (password === undefined) {
    throw new Error('Set MIGRATION_DB_PASSWORD (or the selected database password).');
  }
  const ca = readCa();
  const caPath = localOnly() ? undefined : process.env.RDS_CA_BUNDLE;
  if (options.execute && (options.confirmTarget !== config.schema
      || options.confirmHost !== config.host)) {
    throw new Error(
      `To write, confirm target ${config.schema} and host ${config.host}.`);
  }

  const baseArgs = ['--env', 'runtime', '-c', 'file://runtime.hcl'];
  if (options.execute) await assertRecoveryLease();
  let args;
  if (options.action === 'status') {
    args = ['migrate', 'status', ...baseArgs];
  } else {
    const plan = await selectedMigrations(config, password, ca, options);
    const { selected } = plan;
    const sourceConfig = databaseConfigs().dev;
    const sourcePassword = passwordFor(sourceConfig);
    if (sourcePassword === undefined) throw new Error('Source database password is required for numeric fidelity validation.');
    const source = await mysql.createConnection({
      host: sourceConfig.host, port: sourceConfig.port, database: sourceConfig.schema,
      user: sourceConfig.user, password: sourcePassword, ssl: sslFor(sourceConfig, ca),
      connectTimeout: 15000,
    });
    try {
      const definitions = await readNumericSource(source, sourceConfig.schema);
      if (validateNumericSelection(selected, plan.pending, definitions, { ...plan, allowDestructive: options.allowDestructive })) {
        console.log('Empty-target historical replay is covered by an approved numeric correction. Content remains blocked until final schema verification.');
      }
    } finally { await source.end(); }
    console.log(`Reviewed migrations selected: ${selected.map(migration => migration.name).join(', ')}`);
    args = ['migrate', 'apply', options.count, ...baseArgs];
    if (options.allowDirty) args.push('--allow-dirty');
    if (!options.execute) args.push('--dry-run');
  }
  const elapsedMs = runAtlas(args, config, password, caPath);
  console.log(JSON.stringify({
    action: options.action, database: config.schema,
    executed: options.action === 'apply' && options.execute, elapsedMs,
  }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
