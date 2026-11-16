// Builds a related schema of any size plus a change touching every table and its exact reverse.
// Each table references the previous one, so the schema is one foreign-key chain of `count` tables.
export function generatedSchema(count, prefix = 'gen') {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Generated schema needs at least one table.');
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) throw new Error('Generated schema prefix must be a plain identifier.');
  const tables = Array.from({ length: count }, (_, index) => `${prefix}_t${String(index + 1).padStart(5, '0')}`);
  const create = tables.map((table, index) => [
    `CREATE TABLE \`${table}\` (`,
    '  `id` int NOT NULL,',
    "  `label` varchar(40) NOT NULL DEFAULT '',",
    ...(index ? ['  `parent_id` int NULL,'] : []),
    '  PRIMARY KEY (`id`)' + (index ? ',' : ''),
    ...(index ? [`  KEY \`${table}_parent\` (\`parent_id\`),`,
      `  CONSTRAINT \`${table}_parent_fk\` FOREIGN KEY (\`parent_id\`) REFERENCES \`${tables[index - 1]}\` (\`id\`)`] : []),
    ') ENGINE=InnoDB;',
  ].join('\n')).join('\n');
  // Every table gains a column and index; every second table also widens an existing column.
  const up = tables.map((table, index) => `ALTER TABLE \`${table}\` ADD COLUMN \`status\` varchar(20) NOT NULL DEFAULT 'new', `
    + `ADD KEY \`${table}_status\` (\`status\`)`
    + (index % 2 ? ", MODIFY COLUMN `label` varchar(80) NOT NULL DEFAULT ''" : '') + ';').join('\n');
  const down = [...tables].reverse().map(table => {
    const index = tables.indexOf(table);
    return `ALTER TABLE \`${table}\` DROP KEY \`${table}_status\`, DROP COLUMN \`status\``
      + (index % 2 ? ", MODIFY COLUMN `label` varchar(40) NOT NULL DEFAULT ''" : '') + ';';
  }).join('\n');
  return { tables, create, up, down };
}
