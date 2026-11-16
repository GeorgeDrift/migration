import mysql from 'mysql2/promise';
import { passwordFor, readCa, sslFor } from './database-config.mjs';
import { loadMigrations } from './migration-policy.mjs';
import { readRevisions } from './schema-stage.mjs';
import { createRecovery, recoveryDirectory } from './recovery.mjs';
import { planSchemaRollback, applySchemaRollback, loadSchemaSnapshot, readSchemaState,
  compareSchemaState } from './schema-rollback.mjs';

export async function reviewedDown(options, databases, { print = console.log, open = createRecovery } = {}) {
  const target = databases.target;
  const ca = readCa();
  const db = await mysql.createConnection({ host: target.host, port: target.port, database: target.schema,
    user: target.user, password: passwordFor(target), ssl: sslFor(target, ca), connectTimeout: 15000 });
  let recovery;
  try {
    const revisions = await readRevisions(db, target.schema);
    if (!revisions.length) return undefined;
    const migrations = loadMigrations();
    const plan = planSchemaRollback(migrations, revisions, options.steps);
    const root = recoveryDirectory();
    for (const item of plan.migrations) {
      if (!loadSchemaSnapshot(root, item.version, target)) {
        throw new Error(`Missing pre-migration evidence for ${item.name}; use a full checkpoint restore.`);
      }
    }
    const preview = { action: 'schema-down', mode: 'reviewed', executed: false,
      requiresAllowDestructive: plan.requiresAllowDestructive,
      changes: plan.migrations.map(item => ({ id: item.version, sql: item.sql })),
      warning: 'Schema undo may discard records. A full checkpoint is taken before execution.' };
    if (!options.execute) { print(JSON.stringify(preview)); return preview; }
    if (options.confirmTarget !== target.schema || options.confirmHost !== target.host) {
      throw new Error('Schema undo confirmation does not match the configured target.');
    }
    if (plan.requiresAllowDestructive && !options.allowDestructive) {
      throw new Error('Reviewed schema undo requires --allow-destructive.');
    }
    recovery = await open(databases, ca, { print });
    const locked = planSchemaRollback(loadMigrations(), await readRevisions(db, target.schema), options.steps);
    if (JSON.stringify(locked) !== JSON.stringify(plan)) throw new Error('Undo history changed; preview again.');
    const checkpoint = await recovery.checkpoint('Before reviewed schema undo');
    try {
      const undone = await applySchemaRollback(db, locked, {
        print, assertSafe: () => recovery.assertSafe(),
        verifyMigration: async item => {
          const snapshot = loadSchemaSnapshot(root, item.version, target);
          if (!snapshot || compareSchemaState(snapshot.tables, await readSchemaState(db, target.schema)).length) {
            throw new Error(`Schema verification failed after undoing ${item.name}.`);
          }
        },
      });
      const result = { action: 'schema-down', mode: 'reviewed', executed: true, undone, checkpoint: checkpoint.id };
      print(JSON.stringify(result));
      return result;
    } catch (error) {
      try { await recovery.restore(checkpoint); }
      catch (restoreError) { throw new Error(`${error.message} Automatic restore failed: ${restoreError.message}`); }
      throw new Error(`${error.message} Restored checkpoint ${checkpoint.id}.`);
    }
  } finally {
    await db.end().catch(() => {});
    if (recovery) await recovery.close();
  }
}
