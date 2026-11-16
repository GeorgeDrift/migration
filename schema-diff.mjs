import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { databaseConfigs, localOnly, passwordFor, readCa, sslFor } from './database-config.mjs';
import mysql from 'mysql2/promise';
import { readSchemaMetadata } from './schema-metadata.mjs';
import { assertNumericFidelity, preserveNumericDefinitions, readNumericSource } from './numeric-fidelity.mjs';
import { loadMigrations, pendingMigrations } from './migration-policy.mjs';
import { readRevisions } from './schema-stage.mjs';
import { inspectFreshReplay } from './fresh-replay.mjs';

const databases = databaseConfigs();

function urlFor(config, caPath) {
  const url = new URL(`maria://${config.host}:${config.port}/${config.schema}`);
  url.username = config.user;
  url.password = passwordFor(config);
  if (caPath) {
    url.searchParams.set('tls', 'true');
    url.searchParams.set('ssl-ca', caPath);
  }
  return url.toString();
}

async function main() {
  const replayCorrection = process.argv.length === 3 && process.argv[2] === '--replay-correction';
  // --reverse prints SQL that turns a source-shaped target back into the current target.
  const reverse = process.argv.length === 3 && process.argv[2] === '--reverse';
  if (process.argv.length !== 2 && !replayCorrection && !reverse) {
    throw new Error('Usage: node schema-diff.mjs [--replay-correction | --reverse] (read-only)');
  }
  const sourcePassword = passwordFor(databases.dev);
  const targetPassword = passwordFor(databases.target);
  if (sourcePassword === undefined || targetPassword === undefined) {
    throw new Error('Set MIGRATION_DB_PASSWORD (or both database passwords).');
  }
  const ca = readCa();
  const caPath = localOnly() ? undefined : process.env.RDS_CA_BUNDLE;
  if (replayCorrection) {
    const connections = [];
    try {
      for (const config of [databases.dev, databases.target]) {
        connections.push(await mysql.createConnection({
          host: config.host, port: config.port, database: config.schema, user: config.user,
          password: passwordFor(config), ssl: sslFor(config, ca),
          connectTimeout: 15000,
        }));
      }
      const revisions = await readRevisions(connections[1], databases.target.schema);
      const pending = pendingMigrations(loadMigrations(), revisions);
      const proposal = await inspectFreshReplay(connections[0], connections[1], databases, pending,
        { hasRevisionHistory: revisions.hasTable });
      if (!proposal?.correctionSql) throw new Error('No supported empty-target historical numeric correction is available. Do not change applied migration files.');
      process.stdout.write(proposal.correctionSql);
      return;
    } finally {
      for (const connection of connections) await connection.end().catch(() => {});
    }
  }
  const sourceUrl = urlFor(databases.dev, caPath);
  const targetUrl = urlFor(databases.target, caPath);
  const result = spawnSync(process.env.ATLAS_BIN || 'atlas', [
    'schema', 'diff', '--env', 'compare', '-c', 'file://compare.hcl',
    ...(reverse ? ['--from', 'env://source', '--to', 'env://target'] : ['--from', 'env://target', '--to', 'env://source']),
    '--exclude', 'atlas_schema_revisions', '--format', '{{ sql . }}',
  ], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ATLAS_SOURCE_URL: sourceUrl, ATLAS_TARGET_URL: targetUrl },
  });
  const redact = value => [sourcePassword, targetPassword].filter(Boolean)
    .reduce((text, password) => text.replaceAll(password, '[REDACTED]')
      .replaceAll(encodeURIComponent(password), '[REDACTED]'), value || '');
  if (result.stderr) process.stderr.write(redact(result.stderr));
  if (result.error || result.status !== 0) {
    throw new Error(`Atlas schema diff failed (${result.error?.message || result.status}). No changes were applied.`);
  }
  const connections = [];
  try {
    for (const config of [databases.dev, databases.target]) {
      connections.push(await mysql.createConnection({
        host: config.host, port: config.port, database: config.schema, user: config.user,
        password: passwordFor(config), ssl: sslFor(config, ca),
        connectTimeout: 15000, supportBigNumbers: true, bigNumberStrings: true,
      }));
    }
    // Numeric definitions of the desired side are preserved; reverse SQL desires the current target.
    const [desired, current] = reverse
      ? [[connections[1], databases.target.schema], [connections[0], databases.dev.schema]]
      : [[connections[0], databases.dev.schema], [connections[1], databases.target.schema]];
    const definitions = await readNumericSource(...desired);
    const currentMeta = await readSchemaMetadata(current[0], current[1], [...definitions.keys()]);
    const sql = preserveNumericDefinitions(result.stdout || '', definitions, currentMeta);
    assertNumericFidelity(sql, definitions);
    process.stdout.write(redact(sql));
  } finally {
    for (const connection of connections) await connection.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
