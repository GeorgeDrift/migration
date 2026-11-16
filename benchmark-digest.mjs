import { createHash } from 'node:crypto';
import { readSchemaState } from './schema-rollback.mjs';
import { readSchemaMetadata, selectRowList } from './schema-metadata.mjs';
import { quoteIdentifier } from './copy-data.mjs';

function canonical(value) {
  if (Buffer.isBuffer(value)) return { binary: value.toString('base64') };
  if (value instanceof Date) throw new Error('Benchmark connections must use dateStrings: true.');
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  if (typeof value === 'bigint') return { bigint: String(value) };
  return value;
}

// Operator supplies an isolated, paused connection with dateStrings/jsonStrings/bigNumberStrings enabled.
export async function benchmarkDatabaseDigest(db, schema, {
  readState = readSchemaState, readMetadata = readSchemaMetadata,
} = {}) {
  if (!/^fabla_(bench|ci)_[a-z0-9_]+$/.test(schema)) throw new Error('Digest helper is restricted to disposable benchmark or CI schemas.');
  const state = await readState(db, schema);
  const names = Object.keys(state).sort();
  const metadata = await readMetadata(db, schema, names);
  const schemaSha256 = createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
  const hash = createHash('sha256');
  const counts = {};
  for (const table of names) {
    const definition = metadata.get(table);
    if (!definition.identityKey.length) throw new Error(`Benchmark table ${table} needs a stable unique identity.`);
    const [rows] = await db.query(`SELECT ${selectRowList(definition)} FROM ${quoteIdentifier(table)} ORDER BY ${definition.identityKey.map(quoteIdentifier).join(', ')}`);
    counts[table] = rows.length;
    hash.update(JSON.stringify([table, rows.length]) + '\n');
    for (const row of rows) hash.update(JSON.stringify(canonical(row)) + '\n');
  }
  const rowsSha256 = hash.digest('hex');
  return { tables: names.length, counts, totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    schemaSha256, rowsSha256, digest: createHash('sha256').update(schemaSha256 + rowsSha256).digest('hex') };
}
