import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import mysql from 'mysql2';
import { databaseConfigs, passwordFor, readCa, sslFor } from './database-config.mjs';
import { floatColumns, isGeneratedColumn, readSchemaMetadata, selectColumnList } from './schema-metadata.mjs';
import { listApplicationTables } from './schema-stage.mjs';
import { assertConfirmedTarget, parseWriteOptions } from './write-options.mjs';
import { assertRecoveryLease } from './recovery.mjs';
import { insertPreparedRows } from './prepared-batches.mjs';

export function quoteIdentifier(value) {
  const tick = String.fromCharCode(96);
  return tick + String(value).replaceAll(tick, tick + tick) + tick;
}

export function compareSchemas(
  sourceTables, targetTables, sourceColumns, targetColumns,
  sourceIndexes = [], targetIndexes = [], sourceKeys = [], targetKeys = [],
) {
  const names = tables => tables.map(row => row.TABLE_NAME).sort();
  if (JSON.stringify(names(sourceTables)) !== JSON.stringify(names(targetTables))) {
    throw new Error('Source and target table lists differ. Apply the reviewed schema first.');
  }
  for (const table of sourceTables) {
    if (table.ENGINE !== 'InnoDB'
        || targetTables.find(row => row.TABLE_NAME === table.TABLE_NAME)?.ENGINE !== 'InnoDB') {
      throw new Error(`All-record copy requires InnoDB tables: ${table.TABLE_NAME}`);
    }
  }
  for (const [label, left, right] of [
    ['columns', sourceColumns, targetColumns],
    ['indexes', sourceIndexes, targetIndexes],
    ['constraints', sourceKeys, targetKeys],
  ]) {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      throw new Error(`Source and target ${label} differ. Apply reviewed schema changes first.`);
    }
  }
}

export function sameValue(left, right) {
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) return left.equals(right);
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return isDeepStrictEqual(left, right);
}

export function orderTables(metadata) {
  const names = [...metadata.keys()].sort();
  const parents = new Map(names.map(name => [name, new Set()]));
  for (const name of names) {
    const definition = metadata.get(name);
    if (definition.engine !== 'InnoDB') throw new Error(`Only InnoDB is supported: ${name}`);
    if (!definition.identityKey.length) throw new Error(`No primary or unique identity key: ${name}`);
    for (const key of definition.keys) {
      const parent = key.REFERENCED_TABLE_NAME;
      if (!parent) continue;
      if (key.REFERENCED_TABLE_SCHEMA && key.REFERENCED_TABLE_SCHEMA !== '@local') {
        throw new Error(`Cross-schema foreign key in ${name} requires explicit mapping and review.`);
      }
      if (!parents.has(parent)) {
        throw new Error(`Table ${name} references an external table ${parent}; review it first.`);
      }
      parents.get(name).add(parent);
    }
  }
  const ordered = [];
  while (parents.size) {
    const ready = [...parents].filter(([, dependencies]) =>
      [...dependencies].every(parent => ordered.includes(parent))).map(([name]) => name);
    if (ready.length === 0) {
      throw new Error(`Foreign-key cycle prevents safe ordered copy: ${[...parents.keys()].join(', ')}`);
    }
    for (const name of ready) {
      ordered.push(name);
      parents.delete(name);
    }
  }
  return ordered;
}

async function existingRows(db, table, columns, keys, batch, floats = []) {
  const identifiers = keys.map(quoteIdentifier);
  const marker = `(${keys.map(() => '?').join(', ')})`;
  const where = keys.length === 1
    ? `${identifiers[0]} IN (${batch.map(() => '?').join(', ')})`
    : `(${identifiers.join(', ')}) IN (${batch.map(() => marker).join(', ')})`;
  const values = batch.flatMap(row => keys.map(key => row[key]));
  const [rows] = await db.query(
    `SELECT ${selectColumnList(columns, floats)}
       FROM ${quoteIdentifier(table)} WHERE ${where}`,
    values,
  );
  return rows;
}

function keyOf(row, keys) {
  return JSON.stringify(keys.map(key => {
    const value = row[key];
    if (Buffer.isBuffer(value)) return { binary: value.toString('base64') };
    if (value instanceof Date) return { date: value.toISOString() };
    return value;
  }));
}

// Pass the same `floats` used to read the source batch so both sides compare exact FLOAT values.
export async function reconcileBatch(db, table, columns, keys, batch, { execute = true, floats = [], insertOptions } = {}) {
  if (!batch.length) return { missing: 0, identical: 0 };
  const existing = new Map((await existingRows(db, table, columns, keys, batch, floats))
    .map(row => [keyOf(row, keys), row]));
  const missing = [];
  let identical = 0;
  for (const row of batch) {
    const found = existing.get(keyOf(row, keys));
    if (!found) missing.push(columns.map(column => row[column]));
    else if (columns.some(column => !sameValue(row[column], found[column]))) {
      throw new Error(`Existing target row differs from source in ${table}; refusing to overwrite it.`);
    } else identical++;
  }
  if (execute) {
    await insertPreparedRows(db, table, columns, missing, insertOptions);
  }
  return { missing: missing.length, identical };
}

export function connect(config, ca, createConnection = mysql.createConnection) {
  return createConnection({
    host: config.host, port: config.port, database: config.schema, user: config.user,
    password: passwordFor(config), ssl: sslFor(config, ca),
    connectTimeout: 15000, supportBigNumbers: true, bigNumberStrings: true,
    // Preserve MariaDB JSON text instead of passing decoded values to SQL.
    jsonStrings: true,
    dateStrings: true,
  }).promise();
}

async function rowCount(db, table) {
  const [[row]] = await db.query(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`);
  return BigInt(row.total);
}

async function scanTable(source, target, table, definition, execute) {
  const columns = definition.columns.filter(column => !isGeneratedColumn(column))
    .map(column => column.COLUMN_NAME);
  const keys = definition.identityKey;
  const floats = floatColumns(definition);
  const sql = `SELECT ${selectColumnList(columns, floats)}
    FROM ${quoteIdentifier(table)} ORDER BY ${keys.map(quoteIdentifier).join(', ')}`;
  let batch = [];
  let missing = 0n;
  let identical = 0n;
  for await (const row of source.connection.query(sql).stream({ highWaterMark: 50 })) {
    batch.push(row);
    if (batch.length === 50) {
      const result = await reconcileBatch(target, table, columns, keys, batch, { execute, floats });
      missing += BigInt(result.missing);
      identical += BigInt(result.identical);
      batch = [];
    }
  }
  if (batch.length) {
    const result = await reconcileBatch(target, table, columns, keys, batch, { execute, floats });
    missing += BigInt(result.missing);
    identical += BigInt(result.identical);
  }
  return { pending: String(missing), identical: String(identical) };
}

async function main(args = process.argv.slice(2)) {
  const databases = databaseConfigs();
  const options = parseWriteOptions(args,
    'Usage: node copy-data.mjs [--execute --confirm-target NAME --confirm-host HOST]');
  assertConfirmedTarget(options, databases.target);
  if (options.execute) await assertRecoveryLease(databases);
  if (!options.execute && !options.strictPreview) {
    const { runComparison } = await import('./compare-db.mjs');
    return runComparison({ includeProcedures: false });
  }
  if (passwordFor(databases.dev) === undefined || passwordFor(databases.target) === undefined
     ) {
    throw new Error('Set both database passwords.');
  }
  const ca = readCa();
  const [source, target] = await Promise.all([
    connect(databases.dev, ca), connect(databases.target, ca),
  ]);
  const completed = [];
  let inTransaction = false;
  try {
    await source.query("SET SESSION time_zone = '+00:00'");
    await target.query("SET SESSION time_zone = '+00:00'");
    const [sourceNames, targetNames] = await Promise.all([
      listApplicationTables(source, databases.dev.schema),
      listApplicationTables(target, databases.target.schema),
    ]);
    if (!sourceNames.length) throw new Error('Source has no application tables.');
    if (JSON.stringify(sourceNames) !== JSON.stringify(targetNames)) {
      throw new Error('Source and target table lists differ.');
    }
    const [sourceMeta, targetMeta] = await Promise.all([
      readSchemaMetadata(source, databases.dev.schema, sourceNames),
      readSchemaMetadata(target, databases.target.schema, sourceNames),
    ]);
    for (const name of sourceNames) {
      if (JSON.stringify(sourceMeta.get(name)) !== JSON.stringify(targetMeta.get(name))) {
        throw new Error(`Source and target definitions differ for ${name}.`);
      }
    }
    const order = orderTables(sourceMeta);
    await source.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await source.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const preview = [];
    for (const table of order) {
      const sourceRows = await rowCount(source, table);
      const targetRows = await rowCount(target, table);
      const scan = await scanTable(source, target, table, sourceMeta.get(table), false);
      if (BigInt(scan.pending) + BigInt(scan.identical) !== sourceRows) {
        throw new Error(`Source row count changed while previewing ${table}.`);
      }
      const extra = targetRows - BigInt(scan.identical);
      preview.push({
        table, sourceRows: String(sourceRows), targetRows: String(targetRows),
        extraTargetRows: String(extra), ...scan,
      });
    }
    console.log(JSON.stringify({ action: 'all-data', executed: false, tables: preview }));
    const extras = preview.filter(item => item.extraTargetRows !== '0');
    if (extras.length) {
      throw new Error(`Target contains rows absent from source in: ${extras.map(item => item.table).join(', ')}.`);
    }
    if (!options.execute) return;
    for (const item of preview) {
      const table = item.table;
      await target.beginTransaction();
      inTransaction = true;
      const result = await scanTable(source, target, table, sourceMeta.get(table), true);
      const verification = await scanTable(source, target, table, sourceMeta.get(table), false);
      if (verification.pending !== '0'
          || BigInt(verification.identical) !== BigInt(item.sourceRows)) {
        throw new Error(`Target content mismatch in ${table}; table transaction rolled back.`);
      }
      if (await rowCount(target, table) !== BigInt(item.sourceRows)) {
        throw new Error(`Target row count mismatch in ${table}; table transaction rolled back.`);
      }
      await target.commit();
      inTransaction = false;
      completed.push({ table, inserted: result.pending, identical: result.identical });
      console.log(JSON.stringify({ completedTable: table, ...result }));
    }
    console.log(JSON.stringify({ action: 'all-data', executed: true, completed }));
  } catch (error) {
    if (inTransaction) await target.rollback().catch(() => {});
    throw new Error(`${error.message} Committed tables: ${completed.map(row => row.table).join(', ') || 'none'}.`);
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
