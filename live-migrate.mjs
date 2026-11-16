import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { splitStatements } from './numeric-fidelity.mjs';
import { compareSchemaState, readSchemaState } from './schema-rollback.mjs';

// Schema migration compares the two live databases and applies the difference. Nothing
// here reads migration files: the SQL comes from the live source and target schemas.

const root = fileURLToPath(new URL('.', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function diff(spawn, args) {
  const result = spawn(process.execPath, ['schema-diff.mjs', ...args], {
    cwd: root, env: process.env, encoding: 'utf8', timeout: 120000,
    maxBuffer: 32 * 1024 * 1024, shell: false,
  });
  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    return undefined;
  }
  const sql = (result.stdout || '').trim();
  return sql ? sql + '\n' : '';
}

// Forward SQL makes the target match the source; reverse SQL turns it back afterwards.
export function generateSchemaChange({ spawn = spawnSync } = {}) {
  const sql = diff(spawn, []);
  if (sql === undefined) throw new Error('Schema SQL could not be generated from the live databases. Nothing was changed.');
  if (!sql) {
    throw new Error('The live schemas differ but no SQL could be generated for the difference. Inspect it manually; nothing was changed.');
  }
  const reverseSql = diff(spawn, ['--reverse']) || undefined;
  return {
    sql, sha256: sha256(sql), statements: splitStatements(sql),
    ...(reverseSql ? { reverseSql, reverseStatements: splitStatements(reverseSql) } : {}),
  };
}

// Runs under the recovery lock after the checkpoint; any failure is restored by the caller.
export async function applySchemaChange(db, schema, change, { assertSafe }) {
  const before = await readSchemaState(db, schema);
  for (const statement of change.statements) {
    await assertSafe();
    await db.query(statement);
  }
  const after = await readSchemaState(db, schema);
  if (!compareSchemaState(before, after).length) {
    throw new Error('The schema SQL ran but changed nothing; the target was not migrated.');
  }
  return { before, after };
}
