import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedProcedure, applyApprovedProcedure, prepareProcedure, procedureDefiner,
  procedureHash, referencesSchema, useCurrentDefiner, resolveProcedureDefiner,
  inspectProcedureCopy, procedureIdentity } from '../copy-procedures.mjs';

test('read-only procedure normalization ignores definer differences', () => {
  const source = 'CREATE DEFINER=`emory`@`%` PROCEDURE `example`() BEGIN SELECT 1; END';
  assert.equal(useCurrentDefiner(source),
    'CREATE DEFINER=CURRENT_USER PROCEDURE `example`() BEGIN SELECT 1; END');
  assert.throws(() => useCurrentDefiner('DROP PROCEDURE example'), /Unexpected/);
});

test('procedure copy detects the configured source schema', () => {
  assert.equal(referencesSchema('SELECT * FROM custom-source.items', 'custom-source'), true);
  assert.equal(referencesSchema('SELECT * FROM migration_dev.items', 'custom-source'), false);
});

test('procedure approval binds exact SQL, explicit account and creation SQL mode', () => {
  const context = prepareProcedure({ 'Create Procedure':
    'CREATE DEFINER=`source`@`%` PROCEDURE example() SELECT 1', sql_mode: 'STRICT_TRANS_TABLES' },
  { user: 'routine_reader', host: '%' });
  const { sql, definer, sqlMode } = context;
  assert.match(sql, /^CREATE DEFINER=`routine_reader`@`%`/);
  const policy = { example: { sha256: procedureHash(sql), definer, sqlMode } };
  assert.equal(approvedProcedure(policy, 'example', sql, context), true);
  assert.equal(approvedProcedure(policy, 'example', sql.replace('1', '2'), context), false);
  assert.equal(approvedProcedure(policy, 'example', sql, { ...context, sqlMode: '' }), false);
  assert.equal(approvedProcedure(policy, 'example', sql, { ...context, definer: { user: 'admin', host: '%' } }), false);
  assert.equal(approvedProcedure({ example: { sha256: procedureHash(sql) } }, 'example', sql, context), false);
  assert.equal(procedureDefiner({}), undefined);
  assert.throws(() => procedureDefiner({ MIGRATION_PROCEDURE_DEFINER_USER: 'a\nb',
    MIGRATION_PROCEDURE_DEFINER_HOST: '%' }), /Set both/);
});

test('procedure owner defaults to the authenticated target account without another password', async () => {
  const calls = [];
  const target = { query: async sql => { calls.push(sql); return [[{ account: 'admin@%' }]]; } };
  assert.deepEqual(await resolveProcedureDefiner(target, {}), { user: 'admin', host: '%' });
  assert.deepEqual(calls, ['SELECT CURRENT_USER() AS account']);
  calls.length = 0;
  assert.deepEqual(await resolveProcedureDefiner(target, { MIGRATION_PROCEDURE_DEFINER_USER: 'reader',
    MIGRATION_PROCEDURE_DEFINER_HOST: 'localhost' }), { user: 'reader', host: 'localhost' });
  assert.equal(calls.length, 0);
  await assert.rejects(resolveProcedureDefiner(target, { MIGRATION_PROCEDURE_DEFINER_USER: 'reader' }), /Set both/);
  await assert.rejects(resolveProcedureDefiner({ query: async () => [[{ account: 'invalid' }]] }, {}), /Cannot identify/);
  await assert.rejects(resolveProcedureDefiner({ query: async () => [[{ account: 'admin@' }]] }, {}), /Set both/);
  assert.throws(() => prepareProcedure({ sql_mode: '' }), /resolved target/);
});

test('procedure plans are read-only, endpoint-bound and reject changed or source-qualified routines', async () => {
  const configs = { dev: { host: 'test-host', port: 3306, schema: 'source', user: 'reader' },
    target: { host: 'test-host', port: 3306, schema: 'target', user: 'admin' } };
  const calls = [];
  let sourceSql = 'CREATE DEFINER=`old`@`%` PROCEDURE `example`() SQL SECURITY DEFINER SELECT 1';
  let targetSql;
  const source = {
    execute: async (sql, args) => {
      calls.push(sql);
      return [sql.includes("ROUTINE_TYPE = 'PROCEDURE'")
        ? [{ ROUTINE_NAME: 'example', ROUTINE_DEFINITION: 'SELECT 1' }] : []];
    },
    query: async sql => { calls.push(sql); return [[{ 'Create Procedure': sourceSql, sql_mode: '' }]]; },
  };
  const target = {
    execute: async sql => { calls.push(sql); return [targetSql ? [{ ROUTINE_NAME: 'example', ROUTINE_DEFINITION: 'SELECT 1' }] : []]; },
    query: async sql => { calls.push(sql); return [[sql.startsWith('SELECT')
      ? { account: 'admin@%' } : { 'Create Procedure': targetSql, sql_mode: '' }]]; },
  };
  const plan = await inspectProcedureCopy(source, target, configs, {}, {});
  assert.equal(plan.pending.length, 1);
  assert.equal(plan.pending[0].approved, false);
  assert.match(plan.pending[0].sql, /^CREATE DEFINER=`admin`@`%`/);
  assert.match(plan.pending[0].sql, /SQL SECURITY DEFINER/);
  assert.equal(plan.identity, procedureIdentity(configs));
  const item = plan.pending[0];
  const policy = { example: { sha256: item.sha256, sqlMode: item.sqlMode, definer: item.definer, identity: item.identity } };
  assert.equal((await inspectProcedureCopy(source, target, configs, policy, {})).pending[0].approved, true);
  assert.equal(approvedProcedure(policy, 'example', item.sql, { ...item, identity: 'other-target' }), false);
  targetSql = item.sql;
  assert.equal((await inspectProcedureCopy(source, target, configs, policy, {})).pending.length, 0);
  targetSql = item.sql.replace('SELECT 1', 'SELECT 2');
  await assert.rejects(inspectProcedureCopy(source, target, configs, policy, {}), /refusing to overwrite/);
  targetSql = undefined;
  sourceSql = sourceSql.replace('SELECT 1', 'SELECT * FROM `source`.`items`');
  await assert.rejects(inspectProcedureCopy(source, target, configs, policy, {}), /source schema explicitly/);
  assert.ok(calls.every(sql => /^(SELECT|SHOW)/.test(sql)));
});

test('yes-approved procedures are created and verified without changing SQL SECURITY or keeping the source owner', async () => {
  const definition = { ...prepareProcedure({
    'Create Procedure': 'CREATE DEFINER=`source_owner`@`localhost` PROCEDURE `example`() SQL SECURITY INVOKER SELECT 1',
    sql_mode: 'STRICT_TRANS_TABLES' }, { user: 'admin', host: '%' }), identity: 'approved-target' };
  const policy = { example: { sha256: definition.sha256, sqlMode: definition.sqlMode,
    definer: definition.definer, identity: definition.identity } };
  const calls = [];
  const target = { query: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.startsWith('SELECT')) return [[{ sqlMode: '' }]];
    if (sql.startsWith('SHOW')) return [[{ 'Create Procedure': definition.sql, sql_mode: definition.sqlMode }]];
    return [[]];
  } };
  await applyApprovedProcedure(target, 'example', definition, policy);
  assert.match(definition.sql, /^CREATE DEFINER=`admin`@`%`/);
  assert.match(definition.sql, /SQL SECURITY INVOKER/);
  assert.ok(!definition.sql.includes('source_owner'));
  assert.deepEqual(calls.at(-1), ['SET SESSION sql_mode = ?', ['']]);
  assert.equal(calls.filter(([sql]) => sql.startsWith('CREATE')).length, 1);
  calls.length = 0;
  await assert.rejects(applyApprovedProcedure(target, 'example', { ...definition, identity: 'other-target' }, policy), /requires approval/);
  assert.equal(calls.length, 0);
});

test('failed procedure creation restores the operator session mode and never hides failure', async () => {
  const item = prepareProcedure({ 'Create Procedure': 'CREATE DEFINER=`source`@`%` PROCEDURE x() SELECT 1',
    sql_mode: '' }, { user: 'reader', host: '%' });
  const policy = { x: { sha256: procedureHash(item.sql), sqlMode: '', definer: item.definer } };
  const calls = [];
  const target = { query: async (sql, args) => {
    calls.push([sql, args]);
    if (sql.startsWith('SELECT')) return [[{ sqlMode: 'STRICT_TRANS_TABLES' }]];
    if (sql.startsWith('CREATE')) throw new Error('Access denied');
    return [[]];
  } };
  await assert.rejects(applyApprovedProcedure(target, 'x', item, policy), /Access denied/);
  assert.deepEqual(calls.at(-1), ['SET SESSION sql_mode = ?', ['STRICT_TRANS_TABLES']]);
  calls.length = 0;
  await assert.rejects(applyApprovedProcedure(target, 'x', item, {}), /requires approval/);
  assert.equal(calls.length, 0);
});
