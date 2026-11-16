import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { databaseConfigs, passwordFor, readCa, sslFor } from './database-config.mjs';
import { readSchemaMetadata, schemaDifferences } from './schema-metadata.mjs';
import { listApplicationTables } from './schema-stage.mjs';
import { formatComparison } from './comparison-report.mjs';

export function compareTable(table, sourceDefinition, targetDefinition) {
  const fields = schemaDifferences(sourceDefinition, targetDefinition);
  return {
    table,
    schema: !sourceDefinition ? 'target-only' : !targetDefinition ? 'source-only'
      : fields.length ? 'different' : 'identical',
    fields,
  };
}

export async function runComparison({ json = false, connect = mysql.createConnection } = {}) {
  const databases = databaseConfigs();
  if (passwordFor(databases.dev) === undefined || passwordFor(databases.target) === undefined) {
    throw new Error('Set both database passwords.');
  }
  const ca = readCa();
  const connections = [];
  const report = {
    action: 'schema-comparison', executed: false,
    source: { host: databases.dev.host, schema: databases.dev.schema },
    target: { host: databases.target.host, schema: databases.target.schema },
    tables: [],
  };
  try {
    for (const config of [databases.dev, databases.target]) {
      const db = await connect({
        host: config.host, port: config.port, database: config.schema, user: config.user,
        password: passwordFor(config), ssl: sslFor(config, ca),
        connectTimeout: 15000, supportBigNumbers: true, bigNumberStrings: true,
        dateStrings: true, jsonStrings: true,
      });
      connections.push(db);
      await db.query("SET SESSION time_zone = '+00:00'");
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    }
    const [source, target] = connections;
    const sourceNames = await listApplicationTables(source, databases.dev.schema);
    const targetNames = await listApplicationTables(target, databases.target.schema);
    report.sourceTableCount = sourceNames.length;
    report.targetTableCount = targetNames.length;
    const names = [...new Set([...sourceNames, ...targetNames])].sort();
    const sourceMeta = await readSchemaMetadata(source, databases.dev.schema, names);
    const targetMeta = await readSchemaMetadata(target, databases.target.schema, names);
    report.tables = compareTables(names, sourceMeta, targetMeta);
    report.complete = true;
    console.log(json ? JSON.stringify(report, null, 2) : formatComparison(report));
    return report;
  } finally {
    for (const db of connections) {
      await db.rollback().catch(() => {});
      await db.end().catch(() => {});
    }
  }
}

export function compareTables(names, sourceMeta, targetMeta) {
  return names.map(table => compareTable(table, sourceMeta.get(table), targetMeta.get(table)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const valid = args.every(arg => arg === '--json') && new Set(args).size === args.length;
  if (!valid) {
    console.error('Usage: node compare-db.mjs [--json]. Schema comparison is read-only.');
    process.exitCode = 1;
  } else {
    runComparison({ json: args.includes('--json') })
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
