const quote = value => '`' + String(value).replaceAll('`', '``') + '`';

export function insertLimits(env = process.env) {
  const read = (name, fallback, maximum) => {
    const value = String(env[name] ?? fallback);
    if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) {
      throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
    }
    return Number(value);
  };
  return { maxRows: read('MIGRATION_INSERT_BATCH_SIZE', 50, 500),
    maxBytes: read('MIGRATION_INSERT_MAX_BYTES', 1024 * 1024, 16 * 1024 * 1024) };
}

function valueBytes(value) {
  if (value === undefined) throw new Error('Undefined insert values are forbidden.');
  if (Buffer.isBuffer(value)) return value.length + 16;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') * 2 + 16;
  if (value === null || typeof value === 'number' || typeof value === 'bigint'
      || typeof value === 'boolean' || value instanceof Date) return 64;
  throw new Error('Insert values must be scalar, binary or dates; keep JSON as original text.');
}

// Bounds both prepared statement parameters and estimated packet size; caller owns the transaction.
export async function insertPreparedRows(db, table, columns, rows, limits = insertLimits()) {
  if (!Number.isSafeInteger(limits.maxRows) || limits.maxRows < 1 || limits.maxRows > 500
      || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1
      || limits.maxBytes > 16 * 1024 * 1024 || !columns.length || columns.length > 60000) {
    throw new Error('Invalid prepared insert limits or columns.');
  }
  const prefix = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES `;
  const marker = '(' + columns.map(() => '?').join(', ') + ')';
  const overhead = Buffer.byteLength(prefix) + 256;
  const chunks = [];
  let chunk = [];
  let bytes = overhead;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error('Insert row has the wrong column count.');
    const size = row.reduce((total, value) => total + valueBytes(value), Buffer.byteLength(marker) + 2);
    if (overhead + size > limits.maxBytes) throw new Error(`One row in ${table} exceeds MIGRATION_INSERT_MAX_BYTES; no inserts were sent.`);
    if (chunk.length && (chunk.length >= limits.maxRows || bytes + size > limits.maxBytes
        || (chunk.length + 1) * columns.length > 60000)) {
      chunks.push(chunk); chunk = []; bytes = overhead;
    }
    chunk.push(row); bytes += size;
  }
  if (chunk.length) chunks.push(chunk);
  for (const values of chunks) {
    const [result] = await db.execute(prefix + values.map(() => marker).join(', '), values.flat());
    if (Number(result.affectedRows) !== values.length) throw new Error(`Prepared insert count mismatch in ${table}; roll back the transaction.`);
  }
  return { rows: rows.length, statements: chunks.length };
}
