import assert from 'node:assert/strict';
import test from 'node:test';
import { insertLimits, insertPreparedRows } from '../prepared-batches.mjs';

test('prepared batches preserve values, enforce row bounds and reduce statement count', async () => {
  const calls = [];
  const db = { async execute(sql, values) { calls.push({ sql, values }); return [{ affectedRows: values.length / 3 }]; } };
  const rows = Array.from({ length: 103 }, (_, id) => [id, '{"n":9007199254740993}', Buffer.from([0, 255])]);
  assert.deepEqual(await insertPreparedRows(db, 'items', ['id', 'json', 'binary'], rows), { rows: 103, statements: 3 });
  assert.deepEqual(calls.map(call => call.values.length / 3), [50, 50, 3]);
  assert.deepEqual(calls.flatMap(call => call.values), rows.flat());
  assert.ok(calls.every(call => !/IGNORE|UPDATE|FOREIGN_KEY_CHECKS/.test(call.sql)));
});

test('packet budget and parameter limits are enforced before sending inserts', async () => {
  let calls = 0;
  const db = { async execute(sql, values) { calls++; return [{ affectedRows: values.length }]; } };
  await insertPreparedRows(db, 'a', ['payload'], [['x'.repeat(200)], ['y'.repeat(200)]], { maxRows: 50, maxBytes: 900 });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(insertPreparedRows(db, 'a', ['payload'], [['ok'], ['x'.repeat(1000)]],
    { maxRows: 50, maxBytes: 900 }), /no inserts were sent/);
  assert.equal(calls, 0);
  assert.throws(() => insertLimits({ MIGRATION_INSERT_BATCH_SIZE: '0' }), /integer/);
  await assert.rejects(insertPreparedRows(db, 'a', ['p'], [[undefined]]), /Undefined/);
});

test('constraint failures and count mismatches stop a batch rather than overwriting rows', async () => {
  await assert.rejects(insertPreparedRows({ async execute() { throw new Error('duplicate unique key'); } },
    'a', ['id'], [[1], [2]]), /duplicate unique key/);
  await assert.rejects(insertPreparedRows({ async execute() { return [{ affectedRows: 1 }]; } },
    'a', ['id'], [[1], [2]]), /count mismatch/);
});
