import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { quoteIdentifier, orderTables, reconcileBatch } from '../copy-data.mjs';
import { readSchemaMetadata, compareSchemaMetadata, schemaDifferences, floatColumns, selectRowList } from '../schema-metadata.mjs';
import { readNumericSource, preserveNumericDefinitions, splitStatements } from '../numeric-fidelity.mjs';
import { applySchemaRollback, compareSchemaState, planSchemaRollback, readSchemaState } from '../schema-rollback.mjs';
import { generatedSchema } from './generated-schema.mjs';
import { benchmarkFixture } from '../benchmark-fixture.mjs';
import { REQUIRED_TABLES, OPTIONAL_TABLES, COPY_ORDER, loadExperimentRows,
  orderSelectedTables, buildExperimentPlan, insertPendingRows, findUnhandledDependents } from '../one-experiment.mjs';
import { prepareProcedure, applyApprovedProcedure, approvedProcedure } from '../copy-procedures.mjs';

// This harness may create/drop only random fixtures on an explicitly selected loopback server.
const host = process.env.INTEGRATION_MARIADB_HOST;
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  throw new Error('Integration tests require INTEGRATION_MARIADB_HOST to be a loopback address. Never use RDS.');
}
const port = Number(process.env.INTEGRATION_MARIADB_PORT || 33306);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid integration port.');
if (!process.env.INTEGRATION_MARIADB_PASSWORD) throw new Error('An isolated integration server password is required.');
const id = randomUUID().replaceAll('-', '');
const sourceName = `fabla_ci_${id}_source`;
const targetName = `fabla_ci_${id}_target`;
const routineUser = `ci_${id.slice(0, 20)}`;
const config = { host, port, user: process.env.INTEGRATION_MARIADB_USER || 'root',
  password: process.env.INTEGRATION_MARIADB_PASSWORD, dateStrings: true, jsonStrings: true,
  supportBigNumbers: true, bigNumberStrings: true, multipleStatements: true, connectTimeout: 15000 };
const admin = await mysql.createConnection(config);
const connections = [];
const created = [];
let userCreated = false;
const baseline = readFileSync(new URL('../migrations/202610020001_create_target_tables.sql', import.meta.url), 'utf8');
const allNames = [...baseline.matchAll(/CREATE TABLE `([^`]+)`/g)].map(match => match[1]);

try {
  const [[server]] = await admin.query('SELECT VERSION() AS version');
  assert.match(server.version, /MariaDB/);
  for (const name of [sourceName, targetName]) {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    created.push(name);
    const db = await mysql.createConnection({ ...config, database: name });
    connections.push(db);
    await db.query("SET SESSION time_zone = '+00:00'");
    await db.query(baseline);
  }
  const [source, target] = connections;
  let sourceMeta = await readSchemaMetadata(source, sourceName, allNames);
  let targetMeta = await readSchemaMetadata(target, targetName, allNames);
  assert.equal(sourceMeta.size, 12);
  assert.deepEqual(sourceMeta, targetMeta);

  await source.query('ALTER TABLE study MODIFY diary_incentive DOUBLE(10,2) NOT NULL DEFAULT 0.00, MODIFY bonus_amount DOUBLE(10,2) NOT NULL DEFAULT 0.00');
  sourceMeta = await readSchemaMetadata(source, sourceName, allNames);
  assert.ok(schemaDifferences(sourceMeta.get('study'), targetMeta.get('study')).length);
  const correction = preserveNumericDefinitions('', await readNumericSource(source, sourceName), targetMeta);
  assert.match(correction, /double\(10,2\)/i);
  await target.query(correction);
  targetMeta = await readSchemaMetadata(target, targetName, allNames);
  assert.deepEqual(sourceMeta, targetMeta);
  console.log('PASS real 12-table baseline and exact study numeric reconciliation');

  // MariaDB must finish dropping the foreign key before its name is reused.
  await target.query('ALTER TABLE study DROP FOREIGN KEY study_ibfk_1');
  await target.query('ALTER TABLE study ADD CONSTRAINT study_ibfk_1 FOREIGN KEY (experiment_id) REFERENCES experiment(experiment_id) ON DELETE RESTRICT ON UPDATE RESTRICT');
  const foreignDrift = await readSchemaMetadata(target, targetName, allNames);
  assert.ok(schemaDifferences(sourceMeta.get('study'), foreignDrift.get('study')).some(field => field.field.endsWith('DELETE_RULE')));
  await target.query('ALTER TABLE study DROP FOREIGN KEY study_ibfk_1');
  await target.query('ALTER TABLE study ADD CONSTRAINT study_ibfk_1 FOREIGN KEY (experiment_id) REFERENCES experiment(experiment_id) ON DELETE CASCADE ON UPDATE RESTRICT');
  targetMeta = await readSchemaMetadata(target, targetName, allNames);
  assert.deepEqual(sourceMeta, targetMeta);

  await source.execute('INSERT INTO team(team_id, team_name) VALUES (?, ?)', [1, 'Expected team']);
  await target.execute('INSERT INTO team(team_id, team_name) VALUES (?, ?)', [1, 'Different team']);
  await source.execute(`INSERT INTO experiment(experiment_id, researcher_logincode, experiment_name,
    experiment_organisation, experiment_researcher, experiment_study_info, experiment_date_range,
    team_id, experiment_variables) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [1, 'ci-login', 'Fixture', 'CI', 'Researcher', 'Study info', '2024', 1, '{ "id": 9007199254740993 }']);
  await source.query("INSERT INTO study(study_id, experiment_id, study_name, daily_goal, weekly_goal, diary_incentive) VALUES (1, 1, 'Fixture study', 1, 7, 12.34)");
  await source.query("INSERT INTO diaries(diary_id, diary_name, study_id, start_time, end_time, entries, active_days, frequency) VALUES (1, 'Diary', 1, '09:00', '17:00', 1, '[]', 'daily')");
  await source.query("INSERT INTO questions(question_id, diary_id, title, required) VALUES (1, 1, 'Question', 1)");
  await source.execute('INSERT INTO user(user_id, studycode, experimentid, created_at, extra) VALUES (?, ?, ?, ?, ?)',
    [1, 'ci', 1, '2024-03-10 02:30:00', '{ "id": 9007199254740993 }']);
  await source.query('INSERT INTO user_on_question(user_on_question_id, user_id, question_id, experiment_id) VALUES (1, 1, 1, 1)');
  await source.execute('INSERT INTO user_diary_version(id, user_id, diary_changes) VALUES (?, ?, ?)',
    [1, 1, '["original", "unchanged"]']);
  let available = compareSchemaMetadata(sourceMeta, targetMeta, { required: REQUIRED_TABLES, optional: OPTIONAL_TABLES });
  let order = orderSelectedTables(targetMeta, COPY_ORDER.filter(table => available.includes(table)));
  assert.deepEqual(await findUnhandledDependents(source, sourceName, available), []);
  let selected = await loadExperimentRows(source, 1, available);
  const plan = () => buildExperimentPlan(target, selected, targetMeta, order, source);
  assert.equal((await plan()).missingExternalDependencies[0].reason, 'Parent content differs');
  await target.execute('UPDATE team SET team_name = ? WHERE team_id = ?', ['Expected team', 1]);
  assert.deepEqual((await plan()).missingExternalDependencies, []);
  await target.beginTransaction();
  await insertPendingRows(target, selected, targetMeta, order);
  await target.rollback();
  assert.equal(String((await target.query('SELECT COUNT(*) AS n FROM experiment'))[0][0].n), '0');
  await target.beginTransaction();
  await insertPendingRows(target, selected, targetMeta, order);
  assert.ok((await plan()).tables.every(table => table.pending === 0));
  await target.commit();
  assert.equal((await plan()).conflicts.length, 0);
  assert.ok(Object.values(await insertPendingRows(target, selected, targetMeta, order)).every(count => count === 0));
  assert.equal((await target.query('SELECT created_at, extra FROM user'))[0][0].created_at, '2024-03-10 02:30:00');
  assert.equal(String((await target.query('SELECT COUNT(*) AS n FROM user_diary_version'))[0][0].n), '1');
  await target.execute('UPDATE user SET studycode = ? WHERE user_id = ?', ['conflict', 1]);
  assert.ok((await plan()).conflicts.some(conflict => conflict.table === 'user'));
  await target.execute('UPDATE user SET studycode = ? WHERE user_id = ?', ['ci', 1]);
  console.log('PASS legacy experiment copy, shared-parent content, conflict detection, idempotency and transaction rollback');

  const modern = `
    CREATE TABLE diary_time_window_map (diary_time_window_id INT PRIMARY KEY, diary_id INT NOT NULL,
      FOREIGN KEY (diary_id) REFERENCES diaries(diary_id)) ENGINE=InnoDB;
    CREATE TABLE experiment_variable_labels (id INT PRIMARY KEY, experiment_id INT NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiment(experiment_id)) ENGINE=InnoDB;
    CREATE TABLE notifications (notification_id INT PRIMARY KEY, experiment_id INT NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiment(experiment_id)) ENGINE=InnoDB;
    CREATE TABLE diary_notification_map (id INT PRIMARY KEY, diary_id INT NOT NULL, notification_id INT NOT NULL,
      diary_time_window_id INT NULL, FOREIGN KEY (diary_id) REFERENCES diaries(diary_id),
      FOREIGN KEY (notification_id) REFERENCES notifications(notification_id),
      FOREIGN KEY (diary_time_window_id) REFERENCES diary_time_window_map(diary_time_window_id)) ENGINE=InnoDB;
    CREATE TABLE question_bank (question_bank_id INT PRIMARY KEY, experiment_id INT NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiment(experiment_id)) ENGINE=InnoDB;
    CREATE TABLE diary_question_map (diary_question_map_id INT PRIMARY KEY, diary_id INT NOT NULL, question_bank_id INT NOT NULL,
      FOREIGN KEY (diary_id) REFERENCES diaries(diary_id), FOREIGN KEY (question_bank_id) REFERENCES question_bank(question_bank_id)) ENGINE=InnoDB;`;
  await source.query(modern);
  await target.query(modern);
  await source.query(`INSERT INTO diary_time_window_map VALUES (1, 1);
    INSERT INTO experiment_variable_labels VALUES (1, 1); INSERT INTO notifications VALUES (1, 1);
    INSERT INTO diary_notification_map VALUES (1, 1, 1, 1); INSERT INTO question_bank VALUES (1, 1);
    INSERT INTO diary_question_map VALUES (1, 1, 1);`);
  const modernNames = [...REQUIRED_TABLES, ...OPTIONAL_TABLES];
  sourceMeta = await readSchemaMetadata(source, sourceName, modernNames);
  targetMeta = await readSchemaMetadata(target, targetName, modernNames);
  available = compareSchemaMetadata(sourceMeta, targetMeta, { required: REQUIRED_TABLES, optional: OPTIONAL_TABLES });
  order = orderSelectedTables(targetMeta, COPY_ORDER.filter(table => available.includes(table)));
  selected = await loadExperimentRows(source, 1, available);
  assert.equal((await plan()).missingSelectedParents.length, 0);
  await target.beginTransaction();
  await insertPendingRows(target, selected, targetMeta, order);
  await target.commit();
  assert.ok((await plan()).tables.every(table => table.pending === 0));
  await source.query('CREATE TABLE unhandled (id INT PRIMARY KEY, experiment_id INT, FOREIGN KEY (experiment_id) REFERENCES experiment(experiment_id)) ENGINE=InnoDB');
  assert.deepEqual(await findUnhandledDependents(source, sourceName, available), ['unhandled']);
  console.log('PASS modern optional relationship graph and unknown-child detection');

  const fidelity = `CREATE TABLE fidelity (id BIGINT UNSIGNED PRIMARY KEY, document JSON,
    wall_time DATETIME(6), instant TIMESTAMP(6), day DATE, bytes VARBINARY(8), amount DECIMAL(20,2),
    CONSTRAINT amount_positive CHECK (amount >= 0)) ENGINE=InnoDB`;
  for (const db of [source, target]) { await db.query("SET SESSION sql_mode = ''"); await db.query(fidelity); }
  await source.execute('INSERT INTO fidelity VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['9007199254740993', '{ "number": 9007199254740993 }', '2024-03-10 02:30:00.123456',
      '2024-11-03 05:30:00.123456', '0000-00-00', Buffer.from([0, 255, 1]), '1234567890123456.78']);
  const [[fidelityRow]] = await source.query('SELECT * FROM fidelity');
  assert.equal(fidelityRow.wall_time, '2024-03-10 02:30:00.123456');
  assert.equal(fidelityRow.day, '0000-00-00');
  assert.equal(fidelityRow.id, '9007199254740993');
  const columns = Object.keys(fidelityRow);
  assert.equal((await reconcileBatch(target, 'fidelity', columns, ['id'], [fidelityRow], { execute: false })).missing, 1);
  assert.equal(String((await target.query('SELECT COUNT(*) AS n FROM fidelity'))[0][0].n), '0');
  await reconcileBatch(target, 'fidelity', columns, ['id'], [fidelityRow]);
  assert.deepEqual((await target.query('SELECT * FROM fidelity'))[0][0], fidelityRow);
  assert.equal((await reconcileBatch(target, 'fidelity', columns, ['id'], [fidelityRow])).identical, 1);
  await assert.rejects(reconcileBatch(target, 'fidelity', columns, ['id'], [{ ...fidelityRow, amount: '1.00' }]), /refusing to overwrite/);
  const checksBefore = await readSchemaMetadata(source, sourceName, ['fidelity']);
  await target.query('ALTER TABLE fidelity DROP CONSTRAINT amount_positive, ADD CONSTRAINT amount_positive CHECK (amount > 0)');
  const checksAfter = await readSchemaMetadata(target, targetName, ['fidelity']);
  assert.ok(schemaDifferences(checksBefore.get('fidelity'), checksAfter.get('fidelity')).some(field => field.field.includes('CHECK_CLAUSE')));
  await assert.rejects(target.execute('INSERT INTO fidelity(id, amount) VALUES (?, ?)', [2, -1]));
  console.log('PASS prepared record copying, zero dates, DST wall times, microseconds, JSON, binary, large numbers and CHECK enforcement');

  await admin.query(`CREATE USER ${quoteIdentifier(routineUser)}@'%' IDENTIFIED BY 'disposable-ci-account'`);
  userCreated = true;
  await admin.query(`GRANT SELECT ON ${quoteIdentifier(targetName)}.* TO ${quoteIdentifier(routineUser)}@'%'`);
  await source.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES'");
  await source.query('CREATE PROCEDURE fixture_procedure() SELECT team_name FROM team WHERE team_id = 1');
  const [[sourceProcedure]] = await source.query('SHOW CREATE PROCEDURE fixture_procedure');
  const prepared = prepareProcedure(sourceProcedure, { user: routineUser, host: '%' });
  const policy = { fixture_procedure: { sha256: prepared.sha256, definer: prepared.definer, sqlMode: prepared.sqlMode } };
  assert.equal(approvedProcedure(policy, 'fixture_procedure', prepared.sql, prepared), true);
  await assert.rejects(applyApprovedProcedure(target, 'fixture_procedure', prepared, {}), /requires approval/);
  const [[originalMode]] = await target.query('SELECT @@SESSION.sql_mode AS sqlMode');
  await applyApprovedProcedure(target, 'fixture_procedure', prepared, policy);
  assert.equal((await target.query('SELECT @@SESSION.sql_mode AS sqlMode'))[0][0].sqlMode, originalMode.sqlMode);
  await assert.rejects(target.query('CALL fixture_procedure()'), { code: 'ER_PROCACCESS_DENIED_ERROR' });
  await admin.query(`GRANT EXECUTE ON PROCEDURE ${quoteIdentifier(targetName)}.fixture_procedure TO ${quoteIdentifier(routineUser)}@'%'`);
  assert.equal((await target.query('CALL fixture_procedure()'))[0][0][0].team_name, 'Expected team');
  console.log('PASS explicit restricted procedure definer, exact approval, preserved SQL mode and procedure invocation');

  // The record-copy helper is also exercised over every actual application table, parent-first.
  const names = [...allNames, ...modern.matchAll(/CREATE TABLE ([a-z_]+)/g)].map(value => Array.isArray(value) ? value[1] : value);
  const allMeta = await readSchemaMetadata(source, sourceName, names);
  for (const table of orderTables(allMeta)) {
    const [rows] = await source.query(`SELECT * FROM ${quoteIdentifier(table)}`);
    if (!rows.length) continue;
    const fields = allMeta.get(table).columns.map(column => column.COLUMN_NAME);
    const result = await reconcileBatch(target, table, fields, allMeta.get(table).identityKey, rows);
    assert.equal(result.identical, rows.length);
  }
  console.log('PASS all-record copy helpers against matching real tables');

  // Every common column type, including FLOAT values that need more than six significant digits.
  const everyType = `CREATE TABLE every_type (id INT PRIMARY KEY,
    f FLOAT, f_scaled FLOAT(7,4), f_unsigned FLOAT UNSIGNED, d DOUBLE, d_scaled DOUBLE(10,2),
    dec_big DECIMAL(65,30), dec_neg DECIMAL(10,0), ti TINYINT, si SMALLINT UNSIGNED, mi MEDIUMINT,
    bi BIGINT, bu BIGINT UNSIGNED, bt BIT(5), bt64 BIT(64), bo BOOLEAN, en ENUM('a','b c','é'), st SET('x','y','z'),
    tm TIME(6), yr YEAR, dt DATETIME(6), ts TIMESTAMP(6) NULL, dy DATE, ch CHAR(5), vc VARCHAR(50), tx TEXT,
    l1 VARCHAR(20) CHARACTER SET latin1, bn BINARY(4), vb VARBINARY(16), bl BLOB, js JSON
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
  for (const db of [source, target]) await db.query(everyType);
  const allBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index)).toString('hex');
  await source.query(`INSERT INTO every_type VALUES
    (1, 1.0000001, 123.4567, 3.4028234e38, 0.1e0 + 0.2e0, 12345678.91,
     '12345678901234567890123456789012345.123456789012345678901234567890', -9999999999,
     -128, 65535, -8388608, -9223372036854775808, 18446744073709551615, b'10101',
     b'1111111111111111111111111111111111111111111111111111111111111111', TRUE, 'é', 'x,z',
     '-838:59:59.000000', 2155, '2024-03-10 02:30:00.123456', '2038-01-19 03:14:07.999999', '1000-01-01',
     'ab', '😀 trailing  ', 'line one\\nline "two" \\\\ and \\'three\\'', 'café', X'00FF0001', X'0000', X'${allBytes}',
     '{"b": 1, "a": [1.10, 9007199254740993]}'),
    (2, 16777217, 0.0001, 0, 1 / 3e0, -0.01, '0.000000000000000000000000000001', 0,
     127, 0, 8388607, 9223372036854775807, 0, b'0', b'0', FALSE, 'b c', '',
     '838:59:59.999999', 1901, '9999-12-31 23:59:59.999999', '1970-01-01 00:00:01.000000', '9999-12-31',
     'ABCDE', 'Ünïcödé ✓', '', 'naïve', X'00000000', X'', X'', '[]'),
    (3, 3.14159274, NULL, NULL, 1.7976931348623157e308, ${Array(25).fill('NULL').join(', ')}, 'null')`);
  const everyMeta = (await readSchemaMetadata(source, sourceName, ['every_type'])).get('every_type');
  const everyColumns = everyMeta.columns.map(column => column.COLUMN_NAME);
  const exactFloats = floatColumns(everyMeta);
  assert.deepEqual(exactFloats, ['f', 'f_scaled', 'f_unsigned']);
  const [everyRows] = await source.query(`SELECT ${selectRowList(everyMeta)} FROM every_type ORDER BY id`);
  assert.equal((await reconcileBatch(target, 'every_type', everyColumns, ['id'], everyRows, { floats: exactFloats })).missing, 3);
  assert.equal((await reconcileBatch(target, 'every_type', everyColumns, ['id'], everyRows, { floats: exactFloats })).identical, 3);
  // The server compares stored values: numbers numerically, everything else byte for byte.
  for (const column of everyColumns) {
    const numeric = /^(?:float|double)/i.test(everyMeta.columns.find(item => item.COLUMN_NAME === column).COLUMN_TYPE);
    const left = numeric ? `a.${quoteIdentifier(column)}` : `BINARY a.${quoteIdentifier(column)}`;
    const right = numeric ? `b.${quoteIdentifier(column)}` : `BINARY b.${quoteIdentifier(column)}`;
    const [[{ differing }]] = await admin.query(`SELECT COUNT(*) AS differing FROM ${quoteIdentifier(sourceName)}.every_type a
      JOIN ${quoteIdentifier(targetName)}.every_type b USING (id) WHERE NOT (${left} <=> ${right})`);
    assert.equal(String(differing), '0', `every_type.${column} changed during copy`);
  }
  const [[plain]] = await source.query('SELECT f FROM every_type WHERE id = 1');
  console.log(`PASS every column type copied exactly (FLOAT 1.0000001: plain text read gives ${plain.f}, exact read gives ${everyRows[0].f})`);

  // Fast schema undo on any schema size: create, seed, apply a change, reverse it, require the exact prior schema.
  async function undoRoundTrip(label, { createSql, upSql, downSql, seed = [] }) {
    const name = `fabla_ci_${id}_${label}`;
    await admin.query(`CREATE DATABASE ${quoteIdentifier(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    created.push(name);
    const db = await mysql.createConnection({ ...config, database: name });
    connections.push(db);
    for (const statement of splitStatements(createSql)) await db.query(statement);
    for (const statement of seed) await db.query(statement);
    await db.query('CREATE TABLE atlas_schema_revisions (version varchar(255) PRIMARY KEY, applied int NOT NULL, total int NOT NULL, error longtext NULL)');
    const tableCount = (createSql.match(/CREATE TABLE/gi) || []).length;
    const before = await readSchemaState(db, name);
    const beforeRows = new Map();
    for (const table of Object.keys(before)) {
      beforeRows.set(table, (await db.query(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY id`))[0]);
    }
    assert.equal(Object.keys(before).length, tableCount);
    const up = splitStatements(upSql);
    for (const statement of up) await db.query(statement);
    await db.query('INSERT INTO atlas_schema_revisions VALUES (?, ?, ?, NULL)', ['202601010002', up.length, up.length]);
    const changed = compareSchemaState(before, await readSchemaState(db, name)).length;
    assert.ok(changed > 0, `${label}: the forward change must alter the schema`);
    const [revisions] = await db.query('SELECT version, applied, total, error FROM atlas_schema_revisions');
    const plan = planSchemaRollback([{ name: '202601010002_change.sql', version: '202601010002',
      risk: 'additive', down: { risk: 'destructive' } }], revisions, 1, { readSql: () => downSql });
    const started = performance.now();
    assert.deepEqual(await applySchemaRollback(db, plan, { print: () => {},
      verifyMigration: async () => assert.deepEqual(compareSchemaState(before, await readSchemaState(db, name)), []),
    }), ['202601010002_change.sql']);
    const elapsed = Math.round(performance.now() - started);
    assert.deepEqual(compareSchemaState(before, await readSchemaState(db, name)), []);
    assert.deepEqual((await db.query('SELECT version FROM atlas_schema_revisions'))[0], []);
    for (const [table, expected] of beforeRows) {
      assert.deepEqual((await db.query(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY id`))[0], expected,
        `${label}: every original value in ${table} must survive reversal`);
    }
    return { db, tableCount, changed, elapsed };
  }

  const demo = file => readFileSync(new URL(`../examples/seven-table-demo/migrations/${file}`, import.meta.url), 'utf8')
    .replaceAll('\r\n', '\n');
  const section = (text, label) => text.split(`-- ${label} --\n`)[1].split(/\n-- \w+\.sql --\n/)[0];
  const change = demo('202609250002_seven_table_change.sql');
  const demoRun = await undoRoundTrip('undo_demo', {
    createSql: section(demo('202609250001_baseline.sql'), 'migration.sql'),
    upSql: section(change, 'migration.sql'), downSql: section(change, 'down.sql'),
    seed: splitStatements(benchmarkFixture(20).seed),
  });
  assert.equal((await demoRun.db.query('SELECT email FROM mig_customers WHERE id = 1'))[0][0].email, 'customer1@example.test');
  console.log(`PASS fast schema undo on the demo: ${demoRun.changed} of ${demoRun.tableCount} tables restored exactly, rows kept (${demoRun.elapsed} ms)`);

  // Simulate the server committing a reverse statement before its acknowledgement is lost.
  for (const statement of splitStatements(section(change, 'migration.sql'))) await demoRun.db.query(statement);
  await demoRun.db.query('INSERT INTO atlas_schema_revisions VALUES (?, 7, 7, NULL)', ['202601010002']);
  const downSql = section(change, 'down.sql');
  const journal = [{ name: '202601010002_change.sql', version: '202601010002', risk: 'additive', down: { risk: 'destructive' } }];
  const uncertainPlan = planSchemaRollback(journal, (await demoRun.db.query('SELECT * FROM atlas_schema_revisions'))[0], 1,
    { readSql: () => downSql });
  const interrupted = {
    execute: (...args) => demoRun.db.execute(...args),
    async query(sql) { await demoRun.db.query(sql); throw new Error('Acknowledgement lost after commit'); },
  };
  await assert.rejects(applySchemaRollback(interrupted, uncertainPlan, { print: () => {} }), /uncertain/);
  const interruptedHistory = (await demoRun.db.query('SELECT * FROM atlas_schema_revisions'))[0];
  assert.throws(() => planSchemaRollback(journal, interruptedHistory, 1, { readSql: () => downSql }), /Do not replay DDL/);
  console.log('PASS real committed DDL with a lost acknowledgement blocks blind retry');

  // Any table count: INTEGRATION_UNDO_TABLES sets the generated schema size (default 40).
  const generatedCount = Number(process.env.INTEGRATION_UNDO_TABLES || 40);
  if (!Number.isSafeInteger(generatedCount) || generatedCount < 1) throw new Error('INTEGRATION_UNDO_TABLES must be a positive integer.');
  const generated = generatedSchema(generatedCount);
  const generatedRun = await undoRoundTrip('undo_generated', {
    createSql: generated.create, upSql: generated.up, downSql: generated.down,
    seed: generated.tables.map((table, index) => `INSERT INTO ${quoteIdentifier(table)} (id, label${index ? ', parent_id' : ''}) VALUES (1, 'row'${index ? ', 1' : ''})`),
  });
  assert.equal(generatedRun.changed, generatedCount);
  for (const table of generated.tables) {
    assert.equal(String((await generatedRun.db.query(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`))[0][0].total), '1');
  }
  console.log(`PASS fast schema undo on ${generatedCount} related tables: every table restored exactly, every row kept (${generatedRun.elapsed} ms)`);
} finally {
  for (const db of connections) await db.end();
  for (const name of created) await admin.query(`DROP DATABASE ${quoteIdentifier(name)}`);
  if (userCreated) await admin.query(`DROP USER ${quoteIdentifier(routineUser)}@'%'`);
  await admin.end();
}
