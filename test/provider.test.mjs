import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Sequelize provider includes the seven fixture tables without limiting additional models', () => {
  const result = spawnSync(process.execPath, [
    'node_modules/@ariga/atlas-provider-sequelize/src/index.js',
    'load', '--path', './examples/seven-table-demo/models', '--dialect', 'mariadb',
  ], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stderr, '');
  const names = [...result.stdout.matchAll(/CREATE TABLE IF NOT EXISTS `?(mig_\w+)`?/g)].map(match => match[1]);
  const required = [
    'mig_addresses', 'mig_customers', 'mig_order_items', 'mig_orders',
    'mig_payments', 'mig_products', 'mig_shipments',
  ];
  assert.equal(new Set(names).size, names.length);
  for (const name of required) assert.ok(names.includes(name), `Missing ${name}`);
});
