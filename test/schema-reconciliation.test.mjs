import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { proposeReconciliation, approveReconciliation } from '../schema-reconciliation.mjs';

const databases = {
  dev: { host: 'test-host', port: 3306, schema: 'source', user: 'operator' },
  target: { host: 'test-host', port: 3306, schema: 'target', user: 'operator' },
};
const sql = 'ALTER TABLE `study` MODIFY COLUMN `bonus_amount` double(10,2) NOT NULL DEFAULT 0.00;\n';
const reverse = 'ALTER TABLE `study` MODIFY COLUMN `bonus_amount` double NOT NULL DEFAULT 0;\n';
const digest = text => createHash('sha256').update(text).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fabla-reconcile-'));
  t.after(() => {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test cleanup path.');
    rmSync(absolute, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'migrations'));
  writeFileSync(join(root, 'migration-policy.json'), '{}\n');
  const calls = [];
  const spawn = (binary, args, options) => {
    calls.push({ binary, args, options });
    assert.equal(options.shell, false);
    if (args[0] === 'schema-diff.mjs') return { status: 0, stdout: args.includes('--reverse') ? reverse : sql };
    assert.deepEqual(args, ['migrate', 'hash', '--dir', 'file://migrations']);
    writeFileSync(join(root, 'migrations', 'atlas.sum'), 'h1:test\n');
    return { status: 0 };
  };
  return { root, spawn, calls };
}

test('schema mismatch proposal is read-only and approval appends exact SQL and checksum policy', t => {
  const f = fixture(t);
  const proposal = proposeReconciliation(databases, f);
  assert.equal(proposal.sql, sql);
  assert.deepEqual(readdirSync(join(f.root, 'migrations')), []);
  const record = approveReconciliation(proposal, databases, { ...f, now: new Date('2026-10-02T12:00:00Z') });
  assert.equal(record.name, '20261002120000_reconcile_source_schema.sql');
  assert.equal(readFileSync(join(f.root, 'migrations', record.name), 'utf8'), sql);
  const policy = JSON.parse(readFileSync(join(f.root, 'migration-policy.json'), 'utf8'));
  assert.equal(policy[record.name].sha256, createHash('sha256').update(sql).digest('hex'));
  assert.equal(policy[record.name].risk, 'destructive');
  // Forward and reverse SQL are each generated at preview and regenerated at approval.
  assert.equal(f.calls.filter(call => call.args[0] === 'schema-diff.mjs').length, 4);
  assert.equal(f.calls.filter(call => call.args.includes('--reverse')).length, 2);
  assert.equal(existsSync(join(f.root, '.schema-review.lock')), false);
});

test('approval registers hash-locked reverse SQL for fast schema undo', t => {
  const f = fixture(t);
  const proposal = proposeReconciliation(databases, f);
  assert.equal(proposal.downSql, reverse);
  const record = approveReconciliation(proposal, databases, { ...f, now: new Date('2026-10-02T12:00:00Z') });
  assert.equal(record.reversible, true);
  assert.equal(readFileSync(join(f.root, 'down-migrations', record.name), 'utf8'), reverse);
  const policy = JSON.parse(readFileSync(join(f.root, 'migration-policy.json'), 'utf8'));
  assert.deepEqual(policy[record.name].down, { sha256: digest(reverse), risk: 'destructive' });
});

test('changed reverse SQL cancels approval and unavailable reverse SQL is registered without undo', t => {
  const f = fixture(t);
  const proposal = proposeReconciliation(databases, f);
  assert.throws(() => approveReconciliation(proposal, databases, {
    ...f, spawn: (binary, args, opts) => args.includes('--reverse')
      ? { status: 0, stdout: reverse + 'ALTER TABLE team DROP x;' } : f.spawn(binary, args, opts),
  }), /reverse SQL changed/);
  assert.equal(readFileSync(join(f.root, 'migration-policy.json'), 'utf8'), '{}\n');
  const failing = (binary, args, opts) => args.includes('--reverse') ? { status: 1 } : f.spawn(binary, args, opts);
  const plain = proposeReconciliation(databases, { ...f, spawn: failing });
  assert.equal(plain.downSql, undefined);
  const record = approveReconciliation(plain, databases, { ...f, spawn: failing });
  assert.equal(record.reversible, false);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'migration-policy.json'), 'utf8'))[record.name].down, undefined);
  assert.equal(existsSync(join(f.root, 'down-migrations', record.name)), false);
});

test('changed live SQL, target or proposal cannot inherit approval', t => {
  const f = fixture(t);
  const proposal = proposeReconciliation(databases, f);
  assert.throws(() => approveReconciliation({ ...proposal, sql: sql + 'DROP TABLE team;' }, databases, f), /proposal or target changed/);
  assert.throws(() => approveReconciliation(proposal, { ...databases, target: { ...databases.target, schema: 'other' } }, f), /proposal or target changed/);
  assert.throws(() => approveReconciliation(proposal, databases, {
    ...f, spawn: () => ({ status: 0, stdout: sql + 'ALTER TABLE team ADD x int;' }),
  }), /Live schema SQL changed/);
  assert.deepEqual(readdirSync(join(f.root, 'migrations')), []);
  assert.equal(readFileSync(join(f.root, 'migration-policy.json'), 'utf8'), '{}\n');
});

test('changed local approvals or an invalid journal block registration', t => {
  const f = fixture(t);
  const proposal = proposeReconciliation(databases, f);
  writeFileSync(join(f.root, 'migration-policy.json'), '{}');
  assert.throws(() => approveReconciliation(proposal, databases, f), /history changed/);
  writeFileSync(join(f.root, 'migrations', '202601010001_unreviewed.sql'), sql);
  assert.throws(() => proposeReconciliation(databases, f), /policy and files differ/);
});

test('empty SQL and failed diff cannot silently ignore unsupported drift', t => {
  const f = fixture(t);
  assert.throws(() => proposeReconciliation(databases, { ...f, spawn: () => ({ status: 0, stdout: '' }) }), /no supported generated correction/);
  assert.throws(() => proposeReconciliation(databases, { ...f, spawn: () => ({ status: 1 }) }), /generation failed/);
});

test('failed checksum generation removes only its own SQL and approval without applying to a database', t => {
  const f = fixture(t);
  const proposal = proposeReconciliation(databases, f);
  assert.throws(() => approveReconciliation(proposal, databases, {
    ...f, spawn: (binary, args, opts) => args[0] === 'schema-diff.mjs'
      ? f.spawn(binary, args, opts) : { status: 1 },
  }), /checksum generation failed/);
  assert.deepEqual(readdirSync(join(f.root, 'migrations')), []);
  assert.deepEqual(readdirSync(join(f.root, 'down-migrations')), []);
  assert.equal(readFileSync(join(f.root, 'migration-policy.json'), 'utf8'), '{}\n');
  assert.equal(existsSync(join(f.root, '.schema-review.lock')), false);
});

test('reconciliation never modifies an existing approved migration', t => {
  const f = fixture(t);
  const existing = '202610020001_baseline.sql';
  writeFileSync(join(f.root, 'migrations', existing), 'CREATE TABLE team (id int);');
  const policy = { [existing]: {
    scope: 'schema', risk: 'additive',
    sha256: createHash('sha256').update('CREATE TABLE team (id int);').digest('hex'),
  } };
  writeFileSync(join(f.root, 'migration-policy.json'), JSON.stringify(policy));
  const proposal = proposeReconciliation(databases, f);
  const record = approveReconciliation(proposal, databases, f);
  assert.ok(record.name > existing);
  assert.equal(readFileSync(join(f.root, 'migrations', existing), 'utf8'), 'CREATE TABLE team (id int);');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'migration-policy.json'), 'utf8'))[existing], policy[existing]);
});

test('empty replay correction approval regenerates the same mode and preserves historical SQL', t => {
  const f = fixture(t);
  const name = '202610020001_baseline.sql';
  const original = 'CREATE TABLE `study` (`bonus_amount` double NOT NULL DEFAULT 0.00);\n';
  writeFileSync(join(f.root, 'migrations', name), original);
  writeFileSync(join(f.root, 'migration-policy.json'), JSON.stringify({ [name]: {
    scope: 'schema', risk: 'additive', sha256: createHash('sha256').update(original).digest('hex'),
  } }));
  const proposal = proposeReconciliation(databases, { ...f, replayCorrection: true });
  assert.equal(proposal.replayCorrection, true);
  approveReconciliation(proposal, databases, f);
  const generation = f.calls.filter(call => call.args[0] === 'schema-diff.mjs');
  assert.equal(generation.length, 2);
  assert.ok(generation.every(call => call.args.includes('--replay-correction')));
  assert.equal(readFileSync(join(f.root, 'migrations', name), 'utf8'), original);
});
