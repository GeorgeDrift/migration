import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { proposeProcedureReview, approveProcedureReview } from '../procedure-review.mjs';
import { prepareProcedure, procedureIdentity, approvedProcedure } from '../copy-procedures.mjs';

const configs = { dev: { host: 'source-host', port: 3306, schema: 'source', user: 'reader' },
  target: { host: 'target-host', port: 3306, schema: 'target', user: 'admin' } };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fabla-procedure-review-'));
  t.after(() => {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test cleanup path.');
    rmSync(absolute, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'procedure-policy.json'), '{}\n');
  const item = { name: 'example', ...prepareProcedure({
    'Create Procedure': 'CREATE DEFINER=`old`@`%` PROCEDURE `example`() SELECT 1', sql_mode: 'STRICT_TRANS_TABLES' },
  { user: 'admin', host: '%' }), identity: procedureIdentity(configs), approved: false };
  const plan = { identity: item.identity, definer: item.definer, existing: 0, pending: [item],
    excludedObjects: { functions: [], triggers: [], views: [], events: [] } };
  const calls = [];
  const inspect = async (actual, policy) => {
    calls.push(actual);
    return { ...structuredClone(plan), pending: plan.pending.map(definition => ({ ...definition,
      approved: approvedProcedure(policy, definition.name, definition.sql, definition) })) };
  };
  return { root, item, plan, inspect, calls };
}

test('procedure preview is read-only and yes approval saves exact SQL, account, mode and endpoints without passwords', async t => {
  const f = fixture(t);
  const proposal = await proposeProcedureReview(configs, f);
  assert.equal(readFileSync(join(f.root, 'procedure-policy.json'), 'utf8'), '{}\n');
  assert.equal(proposal.plan.pending[0].approved, false);
  const result = await approveProcedureReview(proposal, configs, f);
  assert.deepEqual(result, { approved: ['example'], definer: { user: 'admin', host: '%' } });
  const policy = JSON.parse(readFileSync(join(f.root, 'procedure-policy.json'), 'utf8'));
  assert.equal(approvedProcedure(policy, 'example', f.item.sql, f.item), true);
  assert.equal(f.calls.length, 2);
  assert.equal(existsSync(join(f.root, '.procedure-review.lock')), false);
  assert.deepEqual(readdirSync(f.root), ['procedure-policy.json']);
  assert.ok(!JSON.stringify(policy).includes('password'));
  const again = await proposeProcedureReview(configs, f);
  assert.equal(again.plan.pending[0].approved, true);
  await approveProcedureReview(again, configs, f);
});

test('changed procedure SQL, SQL mode, account, target or pending set cannot inherit yes approval', async t => {
  const changes = [
    plan => { plan.pending[0].sql += ' '; },
    plan => { plan.pending[0].sqlMode = ''; },
    plan => { plan.pending[0].definer = { user: 'other', host: '%' }; },
    plan => { plan.pending.push({ ...plan.pending[0], name: 'another' }); },
    plan => { plan.existing = 1; },
  ];
  for (const change of changes) {
    const f = fixture(t);
    const proposal = await proposeProcedureReview(configs, f);
    change(f.plan);
    await assert.rejects(approveProcedureReview(proposal, configs, f), /Live procedure/);
    assert.equal(readFileSync(join(f.root, 'procedure-policy.json'), 'utf8'), '{}\n');
    assert.equal(existsSync(join(f.root, '.procedure-review.lock')), false);
  }
  const f = fixture(t);
  const proposal = await proposeProcedureReview(configs, f);
  await assert.rejects(approveProcedureReview(proposal,
    { ...configs, target: { ...configs.target, host: 'other-host' } }, f), /target changed/);
  proposal.plan.pending[0].sql += ' ';
  await assert.rejects(approveProcedureReview(proposal, configs, f), /preview or target changed/);
  assert.equal(f.calls.length, 1);
});

test('concurrent procedure approvals are not overwritten and stale local policy stops registration', async t => {
  const f = fixture(t);
  const proposal = await proposeProcedureReview(configs, f);
  writeFileSync(join(f.root, 'procedure-policy.json'), '{"other":{}}\n');
  await assert.rejects(approveProcedureReview(proposal, configs, f), /policy changed/);
  assert.equal(readFileSync(join(f.root, 'procedure-policy.json'), 'utf8'), '{"other":{}}\n');
  const current = await proposeProcedureReview(configs, f);
  await assert.rejects(approveProcedureReview(current, configs, { ...f, inspect: async (...args) => {
    const plan = await f.inspect(...args);
    writeFileSync(join(f.root, 'procedure-policy.json'), '{"newer":{}}\n');
    return plan;
  } }), /policy changed during/);
  assert.equal(readFileSync(join(f.root, 'procedure-policy.json'), 'utf8'), '{"newer":{}}\n');
  assert.equal(existsSync(join(f.root, '.procedure-review.lock')), false);
});

test('failed live checks, invalid policy and another approval lock cannot save procedure approval', async t => {
  const f = fixture(t);
  const proposal = await proposeProcedureReview(configs, f);
  await assert.rejects(approveProcedureReview(proposal, configs, { ...f,
    inspect: async () => { throw new Error('Access denied'); } }), /Access denied/);
  assert.deepEqual(readdirSync(f.root), ['procedure-policy.json']);
  writeFileSync(join(f.root, '.procedure-review.lock'), 'other review');
  await assert.rejects(approveProcedureReview(proposal, configs, f), /EEXIST/);
  assert.equal(readFileSync(join(f.root, '.procedure-review.lock'), 'utf8'), 'other review');
  writeFileSync(join(f.root, 'procedure-policy.json'), '[]\n');
  await assert.rejects(proposeProcedureReview(configs, f), /Invalid procedure policy/);
});
