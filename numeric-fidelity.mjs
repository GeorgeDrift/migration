import { quoteIdentifier } from './copy-data.mjs';

const identifier = '`(?:``|[^`])+`';
const createPattern = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})\\s*\\(`, 'i');
const alterPattern = new RegExp(`^ALTER\\s+TABLE\\s+(${identifier})\\s+`, 'i');
const columnPattern = new RegExp(`^(${identifier})\\s+`, 'i');
const precisionType = /^(?:double|float)\s*\(\s*\d+\s*,\s*\d+\s*\)/i;
const fullPrecisionType = /^(?:double|float)\s*\(\s*\d+\s*,\s*\d+\s*\)(?:\s+(?:unsigned|zerofill))*/i;
const unquote = value => value.slice(1, -1).replaceAll('``', '`');

// Scan delimiters outside SQL identifiers, literals, comments and nested expressions.
function delimiters(sql, delimiter, { closing = false } = {}) {
  const positions = [];
  let depth = 0;
  let quote;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index++; }
      continue;
    }
    if (quote) {
      if (char === '\\' && quote !== '`') { index++; continue; }
      if (char === quote) {
        if (next === quote) index++;
        else quote = undefined;
      }
      continue;
    }
    if (char === '#' || (char === '-' && next === '-' && /\s/.test(sql[index + 2] || ''))) {
      lineComment = true; continue;
    }
    if (char === '/' && next === '*') { blockComment = true; index++; continue; }
    if (['`', "'", '"'].includes(char)) { quote = char; continue; }
    if (closing && char === ')' && depth === 0) return [index];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === delimiter && depth === 0) positions.push(index);
    if (depth < 0) throw new Error('Unbalanced SQL; numeric fidelity cannot be established.');
  }
  if (quote || blockComment || depth !== 0 || closing) {
    throw new Error('Unterminated SQL; numeric fidelity cannot be established.');
  }
  return positions;
}

function split(sql, delimiter) {
  const positions = delimiters(sql, delimiter);
  const parts = [];
  let start = 0;
  for (const end of positions) { parts.push(sql.slice(start, end).trim()); start = end + 1; }
  parts.push(sql.slice(start).trim());
  return parts.filter(Boolean);
}

function withoutLeadingComments(sql) {
  let text = sql.trim();
  while (/^(?:--\s|#|\/\*)/.test(text)) {
    if (text.startsWith('/*')) {
      const end = text.indexOf('*/');
      if (end < 0) throw new Error('Unterminated SQL comment.');
      // Executable version comments must not be silently discarded.
      if (text.startsWith('/*!')) throw new Error('Executable SQL comments require manual fidelity review.');
      text = text.slice(end + 2).trim();
    } else {
      const end = text.indexOf('\n');
      text = end < 0 ? '' : text.slice(end + 1).trim();
    }
  }
  return text;
}

// Executable statements in file order, without comments-only fragments.
export function splitStatements(sql) {
  return split(sql, ';').map(withoutLeadingComments).filter(Boolean);
}

function createParts(statement) {
  const match = statement.match(createPattern);
  if (!match) return undefined;
  const start = match[0].length;
  const end = start + delimiters(statement.slice(start), ',', { closing: true })[0];
  return { table: unquote(match[1]), start, end, parts: split(statement.slice(start, end), ',') };
}

export function numericDefinitions(createSql) {
  const create = createParts(withoutLeadingComments(createSql));
  if (!create) throw new Error('Expected a quoted SHOW CREATE TABLE definition.');
  const columns = new Map();
  for (const part of create.parts) {
    const match = part.match(columnPattern);
    if (match && precisionType.test(part.slice(match[0].length))) columns.set(unquote(match[1]), part);
  }
  return columns;
}

export async function readNumericSource(connection, schema) {
  const [rows] = await connection.execute(
    "SELECT DISTINCT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('double', 'float') AND TABLE_NAME <> 'atlas_schema_revisions' ORDER BY TABLE_NAME",
    [schema],
  );
  const definitions = new Map();
  for (const row of rows) {
    const [[table]] = await connection.query(`SHOW CREATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(row.TABLE_NAME)}`);
    const columns = numericDefinitions(table['Create Table']);
    if (columns.size) definitions.set(row.TABLE_NAME, columns);
  }
  return definitions;
}

function sameDefinition(left, right) {
  function normalize(text) {
    let result = '';
    let quote;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quote) {
        result += char;
        if (char === '\\' && quote !== '`') { result += text[++index] || ''; continue; }
        if (char === quote) {
          if (text[index + 1] === quote) result += text[++index];
          else quote = undefined;
        }
      } else if (['`', "'", '"'].includes(char)) {
        quote = char; result += char;
      } else if (!/\s/.test(char)) result += char.toLowerCase();
    }
    return result;
  }
  return normalize(left) === normalize(right);
}

export function preserveNumericDefinitions(atlasSql, source, targetMetadata) {
  const statements = split(atlasSql, ';').map(withoutLeadingComments).filter(Boolean);
  const created = new Set();
  const modified = new Map();
  const output = statements.map(statement => {
    const create = createParts(statement);
    if (!create) {
      const alter = statement.match(alterPattern);
      const table = alter && unquote(alter[1]);
      const desired = source.get(table);
      if (!desired?.size) return statement;
      const seen = new Set();
      const parts = split(statement.slice(alter[0].length), ',').map(part => {
        if (/^CHANGE\s/i.test(part)) throw new Error(`Numeric column rename in ${table} requires manual review.`);
        const prefix = part.match(/^(ADD|MODIFY)\s+(?:COLUMN\s+)?/i);
        if (!prefix) return part;
        const body = part.slice(prefix[0].length);
        const match = body.match(columnPattern);
        const name = match && unquote(match[1]);
        if (!desired.has(name)) return part;
        seen.add(name);
        const position = body.match(/\s+(?:FIRST|AFTER\s+`(?:``|[^`])+`)\s*$/i)?.[0] || '';
        return `${prefix[1]} COLUMN ${desired.get(name)}${position}`;
      });
      modified.set(table, new Set([...(modified.get(table) || []), ...seen]));
      return statement.slice(0, alter[0].length) + parts.join(',\n  ');
    }
    created.add(create.table);
    const desired = source.get(create.table);
    if (!desired?.size) return statement;
    const seen = new Set();
    const parts = create.parts.map(part => {
      const match = part.match(columnPattern);
      const name = match && unquote(match[1]);
      if (!desired.has(name)) return part;
      seen.add(name);
      return desired.get(name);
    });
    for (const name of desired.keys()) {
      if (!seen.has(name)) throw new Error(`Generated CREATE TABLE omits ${create.table}.${name}; review before proceeding.`);
    }
    return statement.slice(0, create.start) + '\n  ' + parts.join(',\n  ') + '\n' + statement.slice(create.end);
  });
  for (const [table, columns] of source) {
    if (created.has(table)) continue;
    const target = targetMetadata.get(table);
    if (!target) {
      throw new Error(`Atlas did not generate CREATE TABLE for ${table}; cannot preserve numeric columns.`);
    }
    const corrections = [];
    for (const [name, definition] of columns) {
      if (modified.get(table)?.has(name)) continue;
      const column = target.columns.find(item => item.COLUMN_NAME === name);
      // Emit exact source definitions even if Atlas treats sized and plain DOUBLE as equivalent.
      const wantedType = definition.slice(definition.match(columnPattern)[0].length).match(fullPrecisionType)[0];
      if (!column || column.COLUMN_TYPE.toLowerCase().replaceAll(' ', '') !== wantedType.toLowerCase().replaceAll(' ', '')
          || statements.some(statement => alterPattern.test(statement)
            && unquote(statement.match(alterPattern)[1]) === table)) {
        corrections.push(`MODIFY COLUMN ${definition}`);
      }
    }
    if (corrections.length) {
      output.push(`-- Numeric fidelity correction; review existing values for rounding or range changes.\nALTER TABLE ${quoteIdentifier(table)}\n  ${corrections.join(',\n  ')}`);
    }
  }
  return output.length ? output.join(';\n\n') + ';\n' : '';
}

export function assertNumericFidelity(sql, source) {
  for (const text of split(sql, ';')) {
    const statement = withoutLeadingComments(text);
    const create = createParts(statement);
    const alter = statement.match(alterPattern);
    if (!create && !alter) continue;
    const table = create?.table || unquote(alter[1]);
    const desired = source.get(table);
    if (!desired?.size) continue;
    const parts = create ? create.parts : split(statement.slice(alter[0].length), ',');
    const seen = new Set();
    for (let part of parts) {
      if (!create) {
        if (/^CHANGE\s/i.test(part)) throw new Error(`Numeric column rename in ${table} requires manual review.`);
        if (!/^(?:ADD|MODIFY)\s+(?:COLUMN\s+)?`/i.test(part)) continue;
        part = part.replace(/^(?:ADD|MODIFY)\s+(?:COLUMN\s+)?/i, '')
          .replace(/\s+(?:FIRST|AFTER\s+`(?:``|[^`])+`)\s*$/i, '');
      }
      const match = part.match(columnPattern);
      const name = match && unquote(match[1]);
      if (!desired.has(name)) continue;
      seen.add(name);
      if (!sameDefinition(part, desired.get(name))) {
        throw new Error(`SQL loses or changes the source numeric definition for ${table}.${name}. Regenerate with schema-diff.mjs; do not edit applied migrations.`);
      }
    }
    if (create) {
      for (const name of desired.keys()) {
        if (!seen.has(name)) throw new Error(`SQL omits the source numeric column ${table}.${name}.`);
      }
    }
  }
}

export function replayNumericCorrections(sql, source) {
  const created = new Set();
  const finalDefinitions = new Map();
  for (const text of split(sql, ';')) {
    const statement = withoutLeadingComments(text);
    if (!statement) continue;
    const create = createParts(statement);
    if (create) {
      if (created.has(create.table)) throw new Error('Historical replay contains duplicate CREATE TABLE statements; manual review is required.');
      created.add(create.table);
      const columns = new Map();
      for (const part of create.parts) {
        const match = part.match(columnPattern);
        if (match) columns.set(unquote(match[1]), part);
      }
      finalDefinitions.set(create.table, columns);
      continue;
    }
    const alter = statement.match(alterPattern);
    const table = alter && unquote(alter[1]);
    if (!alter || !created.has(table)) {
      throw new Error('Empty-target numeric replay supports only CREATE TABLE and reviewed numeric MODIFY statements; manual review is required.');
    }
    for (const part of split(statement.slice(alter[0].length), ',')) {
      const prefix = part.match(/^MODIFY\s+(?:COLUMN\s+)?/i);
      const body = prefix && part.slice(prefix[0].length);
      const match = body && body.match(columnPattern);
      const name = match && unquote(match[1]);
      if (!source.get(table)?.has(name) || !finalDefinitions.get(table).has(name)) {
        throw new Error('Empty-target numeric replay cannot prove this ALTER; manual review is required.');
      }
      finalDefinitions.get(table).set(name, body.replace(/\s+(?:FIRST|AFTER\s+`(?:``|[^`])+`)\s*$/i, ''));
    }
  }
  const corrections = [];
  for (const [table, columns] of source) {
    const final = finalDefinitions.get(table);
    if (!final) throw new Error(`Historical replay does not create ${table}; manual review is required.`);
    const changes = [];
    for (const [name, definition] of columns) {
      if (!final.has(name)) throw new Error(`Historical replay omits ${table}.${name}; manual review is required.`);
      if (!sameDefinition(final.get(name), definition)) changes.push(`MODIFY COLUMN ${definition}`);
    }
    if (changes.length) corrections.push(`ALTER TABLE ${quoteIdentifier(table)}\n  ${changes.join(',\n  ')}`);
  }
  return corrections.length
    ? '-- Empty-target historical replay correction; apply after the original CREATE TABLE migrations.\n'
      + corrections.join(';\n\n') + ';\n' : '';
}
