function grid(headers, rows) {
  const cells = [headers, ...rows].map(row => row.map(value => String(value ?? '-')));
  const widths = headers.map((_, column) => Math.max(...cells.map(row => row[column].length)));
  const line = row => row.map((value, column) => value.padEnd(widths[column])).join(' | ');
  return [line(cells[0]), widths.map(width => '-'.repeat(width)).join('-+-'),
    ...cells.slice(1).map(line)].join('\n');
}

const statusLabels = {
  'source-only': 'Missing from target', 'target-only': 'Only in target',
  identical: 'Same', different: 'Different', unavailable: 'Unavailable',
};
const label = status => statusLabels[status] || status || '-';

function definitionSummary(items = []) {
  const matching = items.filter(item => (item.schema || item.status) === 'identical').length;
  return [matching, items.length - matching];
}

export function formatComparison(report) {
  const tables = report.tables || [];
  const [matchingTables, differentTables] = definitionSummary(tables);
  const summary = [
    ['Table schemas', report.sourceTableCount, report.targetTableCount, matchingTables, differentTables],
  ];
  const lines = [
    'DATABASE COMPARISON - READ ONLY',
    `Source: ${report.source.schema} on ${report.source.host}`,
    `Target: ${report.target.schema} on ${report.target.host}`, '',
    grid(['Resource', 'Source', 'Target', 'Matching', 'Schema differences'], summary), '',
    'TABLE SCHEMAS',
    grid(['Table', 'Source', 'Target', 'Schema comparison'], tables.map(table => [
      table.table,
      table.schema === 'target-only' ? 'Missing' : 'Present',
      table.schema === 'source-only' ? 'Missing' : 'Present',
      label(table.schema),
    ])),
  ];
  for (const table of tables) {
    if (table.schema === 'source-only') lines.push(`\n${table.table}: present in source, missing from target.`);
    else if (table.schema === 'target-only') lines.push(`\n${table.table}: missing from source, present in target.`);
    else if (table.fields?.length) {
      lines.push(`\nSCHEMA DIFFERENCES: ${table.table}`);
      lines.push(grid(['Field', 'Source', 'Target'], table.fields.map(field =>
        [field.field, JSON.stringify(field.source), JSON.stringify(field.target)])));
    }
    if (table.reason) lines.push(`${table.table}: ${table.reason}`);
  }
  lines.push('', report.complete ? 'Schema comparison completed. Review differences above.'
    : 'Schema comparison is incomplete: some table definitions were unavailable.',
  'This comparison only reads schema definitions; it changed nothing.');
  return lines.join('\n');
}
