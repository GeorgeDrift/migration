const columnFields = [
  'COLUMN_NAME', 'ORDINAL_POSITION', 'COLUMN_TYPE', 'IS_NULLABLE',
  'COLUMN_DEFAULT', 'EXTRA', 'COLLATION_NAME', 'GENERATION_EXPRESSION',
];

const indexFields = [
  'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'COLLATION',
  'SUB_PART', 'INDEX_TYPE',
];

const keyFields = [
  'CONSTRAINT_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION',
  'REFERENCED_TABLE_NAME', 'REFERENCED_COLUMN_NAME',
  'REFERENCED_TABLE_SCHEMA', 'UPDATE_RULE', 'DELETE_RULE', 'MATCH_OPTION',
];

function project(rows, fields) {
  return rows.map(row => Object.fromEntries(fields.map(field => [field, row[field]])));
}

export function schemaDifferences(source, target, path = '') {
  if (JSON.stringify(source) === JSON.stringify(target)) return [];
  if (source == null || target == null || typeof source !== 'object'
      || typeof target !== 'object' || Array.isArray(source) !== Array.isArray(target)) {
    return [{ field: path || 'table', source: source ?? null, target: target ?? null }];
  }
  return [...new Set([...Object.keys(source), ...Object.keys(target)])]
    .flatMap(key => schemaDifferences(source[key], target[key], path ? `${path}.${key}` : key));
}

export function isGeneratedColumn(column) {
  return /(?:VIRTUAL|STORED) GENERATED/i.test(column.EXTRA || '');
}

const quoteName = value => '`' + String(value).replaceAll('`', '``') + '`';

// MariaDB prints FLOAT values with about six significant digits, which can round
// the stored value. Widening to DOUBLE reads the exact single-precision value, and
// writing that back to a FLOAT column reproduces the identical stored bits.
export function floatColumns(definition) {
  return (definition?.columns || []).filter(column => /^float\b/i.test(column.COLUMN_TYPE || ''))
    .map(column => column.COLUMN_NAME);
}

export function selectColumnList(columns, floats = []) {
  const exact = new Set(floats);
  return columns.map(name => exact.has(name)
    ? `(${quoteName(name)} + 0e0) AS ${quoteName(name)}` : quoteName(name)).join(', ');
}

// Every column of a table in definition order, with FLOAT columns read exactly.
export function selectRowList(definition) {
  return selectColumnList(definition.columns.map(column => column.COLUMN_NAME), floatColumns(definition));
}

export async function readSchemaMetadata(connection, schema, requestedTables) {
  const tables = [...new Set(requestedTables)].sort();
  if (tables.length === 0) return new Map();
  const markers = tables.map(() => '?').join(', ');
  const [tableRows] = await connection.query(
    `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME IN (${markers})
      ORDER BY TABLE_NAME`,
    [schema, ...tables],
  );
  const [columns] = await connection.query(
    `SELECT TABLE_NAME, ${columnFields.join(', ')}
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${markers})
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema, ...tables],
  );
  const [indexes] = await connection.query(
    `SELECT TABLE_NAME, ${indexFields.join(', ')}
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${markers})
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema, ...tables],
  );
  const [keys] = await connection.query(
    `SELECT k.TABLE_NAME, ${keyFields.slice(0, 6).map(field => `k.${field}`).join(', ')},
            r.UPDATE_RULE, r.DELETE_RULE, r.MATCH_OPTION
       FROM information_schema.KEY_COLUMN_USAGE k
       LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
        AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME IN (${markers})
      ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [schema, ...tables],
  );
  const [checks] = await connection.query(
    `SELECT TABLE_NAME, CONSTRAINT_NAME, CHECK_CLAUSE
       FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME IN (${markers})
      ORDER BY TABLE_NAME, CONSTRAINT_NAME`,
    [schema, ...tables],
  );

  return new Map(tableRows.map(table => {
    const name = table.TABLE_NAME;
    const tableColumns = columns.filter(row => row.TABLE_NAME === name);
    const tableKeys = keys.filter(row => row.TABLE_NAME === name);
    const tableIndexes = indexes.filter(row => row.TABLE_NAME === name);
    const primaryKey = tableKeys
      .filter(row => row.CONSTRAINT_NAME === 'PRIMARY')
      .sort((left, right) => left.ORDINAL_POSITION - right.ORDINAL_POSITION)
      .map(row => row.COLUMN_NAME);
    const uniqueIndexName = [...new Set(tableIndexes
      .filter(row => Number(row.NON_UNIQUE) === 0 && row.COLUMN_NAME)
      .map(row => row.INDEX_NAME))].find(indexName => {
      const parts = tableIndexes.filter(row => row.INDEX_NAME === indexName);
      return parts.every(part => tableColumns.some(column =>
        column.COLUMN_NAME === part.COLUMN_NAME && column.IS_NULLABLE === 'NO'));
    });
    const identityKey = primaryKey.length
      ? primaryKey
      : tableIndexes.filter(row => row.INDEX_NAME === uniqueIndexName)
        .sort((left, right) => left.SEQ_IN_INDEX - right.SEQ_IN_INDEX)
        .map(row => row.COLUMN_NAME);
    return [name, {
      engine: table.ENGINE,
      collation: table.TABLE_COLLATION,
      columns: project(tableColumns, columnFields),
      indexes: project(tableIndexes, indexFields),
      keys: project(tableKeys.map(key => ({ ...key,
        REFERENCED_TABLE_SCHEMA: key.REFERENCED_TABLE_SCHEMA === schema
          ? '@local' : key.REFERENCED_TABLE_SCHEMA,
      })), keyFields),
      checks: project(checks.filter(row => row.TABLE_NAME === name), ['CONSTRAINT_NAME', 'CHECK_CLAUSE']),
      identityKey,
    }];
  }));
}

export function compareSchemaMetadata(source, target, { required = [], optional = [] } = {}) {
  const selected = [];
  for (const table of required) {
    if (!source.has(table)) throw new Error(`Required source table is missing: ${table}`);
    if (!target.has(table)) throw new Error(`Required target table is missing: ${table}`);
    selected.push(table);
  }
  for (const table of optional) {
    const inSource = source.has(table);
    const inTarget = target.has(table);
    if (inSource !== inTarget) {
      throw new Error(`Optional table ${table} must exist in both schemas or neither schema.`);
    }
    if (inSource) selected.push(table);
  }
  for (const table of selected) {
    if (JSON.stringify(source.get(table)) !== JSON.stringify(target.get(table))) {
      throw new Error(`Source and target definitions differ for table ${table}. Apply reviewed schema migrations first.`);
    }
    if (source.get(table).engine !== 'InnoDB') {
      throw new Error(`One-experiment copy requires InnoDB for atomic rollback: ${table}`);
    }
    if (source.get(table).identityKey.length === 0) {
      throw new Error(`One-experiment copy requires a primary or unique key for idempotency: ${table}`);
    }
    if (source.get(table).indexes.some(index =>
      Number(index.NON_UNIQUE) === 0 && index.SUB_PART != null)) {
      throw new Error(`Prefix unique indexes need manual collision review: ${table}`);
    }
  }
  return selected;
}
