import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
function section(file, label) {
  const text = readFileSync(new URL(`./examples/seven-table-demo/migrations/${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  return text.split(`-- ${label} --\n`)[1].split(/\n-- \w+\.sql --\n/)[0].trim() + '\n';
}

export function benchmarkFixture(rowsPerTable = 1000) {
  if (!Number.isSafeInteger(rowsPerTable) || rowsPerTable < 1 || rowsPerTable > 100000) {
    throw new Error('Fixture rows per table must be from 1 to 100000.');
  }
  const baseline = section('202609250001_baseline.sql', 'migration.sql');
  const up = section('202609250002_seven_table_change.sql', 'migration.sql');
  const down = section('202609250002_seven_table_change.sql', 'down.sql');
  const tables = [...baseline.matchAll(/CREATE TABLE `([^`]+)`/g)].map(match => match[1]);
  const seed = [];
  const builders = [
    id => `INSERT INTO mig_customers (id,name,email,created_at) VALUES (${id},'Customer ${id}','customer${id}@example.test','2024-01-01 12:00:00');`,
    id => `INSERT INTO mig_products (id,sku,title,price_cents) VALUES (${id},'SKU-${id}','Product ${id}',${1000 + id});`,
    id => `INSERT INTO mig_addresses (id,customer_id,city,postal_code) VALUES (${id},${id},'Test city','00000');`,
    id => `INSERT INTO mig_orders (id,customer_id,created_at) VALUES (${id},${id},'2024-01-01 12:00:00');`,
    id => `INSERT INTO mig_order_items (id,order_id,product_id,quantity,unit_price_cents) VALUES (${id},${id},${id},2,${1000 + id});`,
    id => `INSERT INTO mig_payments (id,order_id,amount_cents,payment_status,created_at) VALUES (${id},${id},${2 * (1000 + id)},'paid','2024-01-01 12:00:00');`,
    id => `INSERT INTO mig_shipments (id,order_id,address_id) VALUES (${id},${id},${id});`,
  ];
  for (const build of builders) for (let id = 1; id <= rowsPerTable; id++) seed.push(build(id));
  const seedSql = seed.join('\n') + '\n';
  const deltaSeed = builders.flatMap(build => Array.from({ length: rowsPerTable }, (_, index) =>
    build(rowsPerTable + index + 1))).join('\n') + '\n';
  const manifest = { format: 1, tables: tables.length, changedTables: tables.length,
    rowsPerTable, totalRows: rowsPerTable * tables.length, tableNames: tables,
    deltaRows: rowsPerTable * tables.length, expectedTotalRows: rowsPerTable * tables.length * 2,
    fixtureSha256: hash(baseline + seedSql + up + deltaSeed + down),
    files: Object.fromEntries(Object.entries({ 'baseline.sql': baseline, 'seed.sql': seedSql,
      'change.sql': up, 'delta-seed.sql': deltaSeed, 'reverse.sql': down }).map(([name, value]) => [name, hash(value)])),
  };
  return { baseline, seed: seedSql, deltaSeed, up, down, manifest };
}

export function writeBenchmarkFixture(directory, rows) {
  if (!isAbsolute(directory)) throw new Error('Benchmark output must be an absolute directory outside the repository.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = realpathSync(directory);
  const repo = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  const inside = relative(repo, root);
  if (!inside || (!inside.startsWith('..' + sep) && inside !== '..' && !isAbsolute(inside))) {
    throw new Error('Keep generated benchmark artifacts outside the repository.');
  }
  const fixture = benchmarkFixture(rows);
  const files = { 'baseline.sql': fixture.baseline, 'seed.sql': fixture.seed, 'change.sql': fixture.up,
    'delta-seed.sql': fixture.deltaSeed, 'reverse.sql': fixture.down,
    'manifest.json': JSON.stringify(fixture.manifest, null, 2) + '\n' };
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents, { flag: 'wx', mode: 0o600 });
  return fixture.manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, rows = '1000', ...extra] = process.argv.slice(2);
  try {
    if (!output || extra.length) throw new Error('Usage: node benchmark-fixture.mjs ABSOLUTE_OUTPUT_DIRECTORY [ROWS_PER_TABLE]');
    console.log(JSON.stringify(writeBenchmarkFixture(output, Number(rows)), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
