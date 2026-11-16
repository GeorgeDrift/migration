import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { databaseConfigs, passwordFor, readCa, sslFor } from './database-config.mjs';
import { loadMigrations, pendingMigrations, readDownSql, assertAllowedSelection } from './migration-policy.mjs';
import { readRevisions } from './schema-stage.mjs';
import { readSchemaState } from './schema-rollback.mjs';
import { splitStatements } from './numeric-fidelity.mjs';

export function reviewedPlan(migrations, revisions, target, { readSql = migration =>
  readFileSync(new URL(`migrations/${migration.name}`, import.meta.url), 'utf8'), readReverse = readDownSql } = {}) {
  const selected = pendingMigrations(migrations, revisions);
  const files = selected.map(migration => ({ ...migration, sql: readSql(migration),
    ...(migration.down ? { reverseSql: readReverse(migration) } : {}) }));
  const sql = files.map(file => file.sql).join('\n');
  const reverseSql = files.length && files.every(file => file.reverseSql)
    ? [...files].reverse().map(file => file.reverseSql).join('\n') : undefined;
  const sha256 = createHash('sha256').update(JSON.stringify({ target, files, revisions })).digest('hex');
  return { mode: 'reviewed', migrations: files, sql, sha256, statements: splitStatements(sql),
    risk: files.some(file => file.risk === 'destructive') ? 'destructive' : 'additive',
    ...(reverseSql ? { reverseSql } : {}) };
}

async function connect(target, ca) {
  return mysql.createConnection({ host: target.host, port: target.port, database: target.schema,
    user: target.user, password: passwordFor(target), ssl: sslFor(target, ca), connectTimeout: 15000 });
}

export async function generateReviewedChange() {
  const databases = databaseConfigs();
  const db = await connect(databases.target, readCa());
  try {
    const target = databases.target;
    return reviewedPlan(loadMigrations(), await readRevisions(db, target.schema),
      { host: target.host, port: target.port, schema: target.schema });
  } finally { await db.end(); }
}

export async function applyReviewedChange(databases, ca, change, recovery, options, run) {
  await recovery.assertSafe();
  const current = await generateReviewedChange();
  if (current.sha256 !== change.sha256) throw new Error('Reviewed migration files or history changed; preview again.');
  assertAllowedSelection(change.migrations, { ...options, action: 'apply' });
  const db = await connect(databases.target, ca);
  try {
    const before = await readSchemaState(db, databases.target.schema);
    for (const migration of change.migrations) {
      await recovery.assertSafe();
      const flags = ['apply', 'target', '--count', '1', '--execute',
        '--confirm-target', options.confirmTarget, '--confirm-host', options.confirmHost];
      if (options.allowDestructive) flags.push('--allow-destructive');
      if (options.allowDirty && migration === change.migrations[0]) flags.push('--allow-dirty');
      if (options.resumePartial) flags.push('--resume-partial');
      await run('run.mjs', flags, { capture: true });
      const revisions = await readRevisions(db, databases.target.schema);
      const applied = revisions.find(revision => String(revision.version) === migration.version);
      if (!applied || applied.error || Number(applied.applied) !== Number(applied.total)) {
        throw new Error(`Migration ${migration.name} has no complete Atlas revision.`);
      }
    }
    return { before, after: await readSchemaState(db, databases.target.schema) };
  } finally { await db.end(); }
}
