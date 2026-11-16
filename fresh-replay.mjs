import { readFileSync } from 'node:fs';
import { assertNumericFidelity, readNumericSource, replayNumericCorrections } from './numeric-fidelity.mjs';

const sqlFor = migration => migration.sql ?? readFileSync(new URL(`migrations/${migration.name}`, import.meta.url), 'utf8');
const numericMismatch = error => /^SQL (?:loses or changes|omits) the source numeric/.test(error.message);

export async function isEmptyTarget(connection, schema) {
  const [[row]] = await connection.execute(
    `SELECT
      (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?) +
      (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?) +
      (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?) +
      (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?) AS objectCount`,
    [schema, schema, schema, schema],
  );
  if (!row || row.objectCount == null || !/^\d+$/.test(String(row.objectCount))) {
    throw new Error('Cannot verify that the target is completely empty.');
  }
  return BigInt(row.objectCount) === 0n;
}

export function validateNumericSelection(selected, pending, source, {
  emptyTarget = false, hasRevisionHistory = true, allowDestructive = false,
} = {}) {
  try {
    for (const migration of selected) assertNumericFidelity(sqlFor(migration), source);
    return false;
  } catch (error) {
    if (!numericMismatch(error) || !emptyTarget || hasRevisionHistory) throw error;
    if (pending.some(migration => migration.partial)) throw new Error('Partial history cannot use empty-target numeric replay.');
    if (pending.some(migration => migration.risk === 'destructive') && !allowDestructive) {
      throw new Error('Empty-target replay correction requires explicit --allow-destructive approval.');
    }
    const correction = replayNumericCorrections(pending.map(sqlFor).join('\n'), source);
    if (correction) {
      throw new Error('Historical initialization needs a reviewed numeric correction. Use the interactive schema-inclusive menu to approve it before replaying.');
    }
    return true;
  }
}

export async function inspectFreshReplay(source, target, databases, pending, { hasRevisionHistory } = {}) {
  if (hasRevisionHistory !== false || !pending.length || !await isEmptyTarget(target, databases.target.schema)) return undefined;
  const definitions = await readNumericSource(source, databases.dev.schema);
  let mismatch = false;
  for (const migration of pending) {
    try { assertNumericFidelity(sqlFor(migration), definitions); }
    catch (error) { if (!numericMismatch(error)) throw error; mismatch = true; }
  }
  if (!mismatch) return undefined;
  if (pending.some(migration => migration.partial)) throw new Error('Partial history cannot use empty-target numeric replay.');
  return { correctionSql: replayNumericCorrections(pending.map(sqlFor).join('\n'), definitions) };
}
