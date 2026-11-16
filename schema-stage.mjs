import { readSchemaMetadata, schemaDifferences } from './schema-metadata.mjs';

export async function listApplicationTables(connection, schema) {
  const [rows] = await connection.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'atlas_schema_revisions' ORDER BY TABLE_NAME",
    [schema],
  );
  return rows.map(row => row.TABLE_NAME);
}

export async function readRevisions(connection, schema) {
  const [tables] = await connection.execute(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'atlas_schema_revisions'",
    [schema],
  );
  if (tables.length === 0) return Object.defineProperty([], 'hasTable', { value: false });
  const [rows] = await connection.query(
    'SELECT version, applied, total, error FROM atlas_schema_revisions ORDER BY version',
  );
  return Object.defineProperty(rows, 'hasTable', { value: true });
}

// Migration is decided only by comparing the live source and target schemas.
export async function inspectSchemaStage(source, target, databases) {
  const [sourceNames, targetNames] = await Promise.all([
    listApplicationTables(source, databases.dev.schema),
    listApplicationTables(target, databases.target.schema),
  ]);
  if (sourceNames.length === 0) {
    throw new Error('Source has no application tables; there is nothing to migrate from.');
  }
  const names = [...new Set([...sourceNames, ...targetNames])];
  const [sourceMeta, targetMeta] = await Promise.all([
    readSchemaMetadata(source, databases.dev.schema, names),
    readSchemaMetadata(target, databases.target.schema, names),
  ]);
  const differences = names.filter(name =>
    JSON.stringify(sourceMeta.get(name)) !== JSON.stringify(targetMeta.get(name)));
  return {
    status: differences.length ? 'different' : 'ready',
    sourceTables: sourceNames.length,
    targetTables: targetNames.length,
    differences,
    differenceDetails: differences.map(table => ({
      table, fields: schemaDifferences(sourceMeta.get(table), targetMeta.get(table)),
    })),
  };
}
