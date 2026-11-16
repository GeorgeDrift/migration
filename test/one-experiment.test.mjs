import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExperimentPlan, findMissingSelectedParents,
  invalidParticipantQuestionLink, orderSelectedTables,
  connect, insertPendingRows,
  findMissingExternalDependencies, loadExperimentRows, REQUIRED_TABLES, OPTIONAL_TABLES,
} from '../one-experiment.mjs';

const definition = {
  engine: 'InnoDB',
  identityKey: ['id'],
  columns: [{ COLUMN_NAME: 'id' }, { COLUMN_NAME: 'code' }],
  indexes: [
    { INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, COLUMN_NAME: 'id', SEQ_IN_INDEX: 1 },
    { INDEX_NAME: 'code_unique', NON_UNIQUE: 0, COLUMN_NAME: 'code', SEQ_IN_INDEX: 1 },
  ],
  keys: [],
};

test('experiment table order rejects self-referencing foreign keys', () => {
  const metadata = new Map([['experiment', {
    ...definition, keys: [{ REFERENCED_TABLE_NAME: 'experiment' }],
  }]]);
  assert.throws(() => orderSelectedTables(metadata, ['experiment']), /cycle/);
});

test('selected foreign-key parents must be included in the experiment graph', () => {
  const metadata = new Map([
    ['parent', definition],
    ['child', { ...definition, keys: [{
      CONSTRAINT_NAME: 'fk_parent', COLUMN_NAME: 'parent_id',
      REFERENCED_TABLE_NAME: 'parent', REFERENCED_COLUMN_NAME: 'id',
      ORDINAL_POSITION: 1,
    }] }],
  ]);
  const rows = new Map([
    ['parent', [{ id: 1 }]],
    ['child', [{ id: 2, parent_id: 3 }]],
  ]);
  assert.equal(findMissingSelectedParents(rows, metadata, ['parent', 'child']).length, 1);
});

test('experiment preview catches alternate unique-key collisions', async () => {
  const target = { query: async sql => {
    if (sql.includes('WHERE `code` = ?')) return [[{ id: 99 }]];
    return [[]];
  } };
  const rows = new Map([['experiment', [{ id: 1, code: 'X' }]]]);
  const plan = await buildExperimentPlan(target, rows,
    new Map([['experiment', definition]]), ['experiment']);
  assert.equal(plan.tables[0].pending, 1);
  assert.deepEqual(plan.conflicts[0], {
    table: 'experiment', uniqueIndex: 'code_unique', identity: { id: 1 },
  });
});

test('current and legacy participant question links validate independently', () => {
  const legacy = new Set(['11']);
  const current = new Set(['22']);
  assert.equal(invalidParticipantQuestionLink({
    experiment_id: 7, question_id: null, diary_question_map_id: 22,
  }, 7, legacy, current), false);
  assert.equal(invalidParticipantQuestionLink({
    experiment_id: 7, question_id: 11, diary_question_map_id: null,
  }, 7, legacy, current), false);
  assert.equal(invalidParticipantQuestionLink({
    experiment_id: 7, question_id: null, diary_question_map_id: 99,
  }, 7, legacy, current), true);
  assert.equal(invalidParticipantQuestionLink({
    experiment_id: 7, question_id: null, diary_question_map_id: null,
  }, 7, legacy, current), true);
});

test('experiment connections retain original JSON text and TLS verification', () => {
  let options;
  const result = {};
  assert.equal(connect({ host: 'fixture', port: 3306, schema: 'target', user: 'operator' },
    Buffer.from('fixture-ca'), config => { options = config; return result; }), result);
  assert.equal(options.jsonStrings, true);
  assert.equal(options.dateStrings, true);
  assert.equal(options.bigNumberStrings, true);
  assert.equal(options.ssl.rejectUnauthorized, true);
});

test('legacy schema selection never queries modern-only tables and includes user diary versions', async () => {
  const available = [...REQUIRED_TABLES, 'questions', 'diary_notifications',
    'experiment_onboarding_questions', 'study_notifications', 'user_diary_version'];
  const fixture = { experiment: [{ experiment_id: 1 }], study: [{ study_id: 2 }],
    diaries: [{ diary_id: 3 }], user: [{ user_id: 4 }], questions: [{ question_id: 5 }],
    user_on_question: [{ user_id: 4, question_id: 5, experiment_id: 1 }],
    user_diary_version: [{ id: 6, user_id: 4 }] };
  const source = { query: async (sql, args) => {
    const table = sql.match(/FROM `([^`]+)`/)[1];
    assert.ok(available.includes(table), `Unexpected table ${table}`);
    if (table === 'user_diary_version') assert.deepEqual(args, [4]);
    return [fixture[table] || []];
  } };
  const rows = await loadExperimentRows(source, 1, available);
  assert.deepEqual([...rows.keys()].sort(), [...available].sort());
  assert.deepEqual(rows.get('user_diary_version'), fixture.user_diary_version);
});

test('modern optional tables retain their declared relationship filters', async () => {
  const available = [...REQUIRED_TABLES, ...OPTIONAL_TABLES];
  const source = { query: async sql => {
    if (sql.includes('FROM `experiment`')) return [[{ experiment_id: 1 }]];
    if (sql.includes('FROM `study`')) return [[{ study_id: 2 }]];
    if (sql.includes('FROM `diaries`')) return [[{ diary_id: 3 }]];
    return [[]];
  } };
  const rows = await loadExperimentRows(source, 1, available);
  assert.deepEqual([...rows.keys()].sort(), [...available].sort());
});

test('external parents must match by complete content, not just a shared composite ID', async () => {
  const metadata = new Map([['experiment', { ...definition, keys: [
    { CONSTRAINT_NAME: 'parent_fk', COLUMN_NAME: 'team_id', REFERENCED_COLUMN_NAME: 'id',
      REFERENCED_TABLE_NAME: 'team', ORDINAL_POSITION: 1 },
    { CONSTRAINT_NAME: 'parent_fk', COLUMN_NAME: 'tenant_id', REFERENCED_COLUMN_NAME: 'tenant',
      REFERENCED_TABLE_NAME: 'team', ORDINAL_POSITION: 2 },
  ] }]]);
  const rows = new Map([['experiment', [{ team_id: 1, tenant_id: 2 }]]]);
  const parent = { id: 1, tenant: 2, name: 'Expected team' };
  const db = records => ({ query: async (sql, values) => {
    assert.match(sql, /SELECT \* FROM `team`/);
    assert.deepEqual(values, [1, 2]);
    return [records];
  } });
  const inspect = target => findMissingExternalDependencies(target, rows, metadata, ['experiment'], db([parent]));
  assert.deepEqual(await inspect(db([parent])), []);
  assert.equal((await inspect(db([{ ...parent, name: 'Different team' }])))[0].reason, 'Parent content differs');
  assert.equal((await inspect(db([])))[0].reason, 'Target parent is missing or ambiguous');
  assert.equal((await inspect(db([parent, parent])))[0].reason, 'Target parent is missing or ambiguous');
  await assert.rejects(findMissingExternalDependencies(db([parent]), rows, metadata, ['experiment']),
    /requires the source connection/);
});

test('experiment inserts use prepared values and preserve JSON without double encoding', async () => {
  const documents = ['["first", "second"]', '"text"', '{ "id": 9007199254740993 }', 'null'];
  const rows = documents.map((document, index) => ({ id: index + 1, payload: document }));
  const calls = [];
  const target = {
    async query(sql) { assert.match(sql, /^SELECT /); return [[]]; },
    async execute(sql, values) {
      assert.match(sql, /^INSERT INTO `experiment`/);
      for (let index = 1; index < values.length; index += 2) assert.doesNotThrow(() => JSON.parse(values[index]));
      calls.push(values);
      return [{ affectedRows: values.length / 2 }];
    },
  };
  const metadata = new Map([['experiment', { ...definition,
    columns: [{ COLUMN_NAME: 'id' }, { COLUMN_NAME: 'payload' }],
  }]]);
  const result = await insertPendingRows(target, new Map([['experiment', rows]]), metadata, ['experiment']);
  assert.deepEqual(result, { experiment: rows.length });
  assert.deepEqual(calls.flat().filter((value, index) => index % 2), documents);
  assert.equal(calls.length, 1);
});

test('repeated external parents are checked once per preview but never cached across previews', async () => {
  let sourceCalls = 0;
  let targetCalls = 0;
  const source = { async query() { sourceCalls++; return [[{ id: 9, name: 'Expected team' }]]; } };
  const target = { async query() { targetCalls++; return [[{ id: 9, name: 'Expected team' }]]; } };
  const metadata = new Map([['experiment', { keys: [{ CONSTRAINT_NAME: 'team_fk', ORDINAL_POSITION: 1,
    COLUMN_NAME: 'team_id', REFERENCED_TABLE_NAME: 'team', REFERENCED_COLUMN_NAME: 'id',
    REFERENCED_TABLE_SCHEMA: '@local' }] }]]);
  const rows = new Map([['experiment', [{ id: 1, team_id: 9 }, { id: 2, team_id: 9 }, { id: 3, team_id: 9 }]]]);
  assert.deepEqual(await findMissingExternalDependencies(target, rows, metadata, ['experiment'], source), []);
  assert.equal(sourceCalls, 1); assert.equal(targetCalls, 1);
  assert.deepEqual(await findMissingExternalDependencies(target, rows, metadata, ['experiment'], source), []);
  assert.equal(sourceCalls, 2); assert.equal(targetCalls, 2);
});
