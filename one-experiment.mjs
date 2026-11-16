import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import mysql from 'mysql2/promise';
import { databaseConfigs, passwordFor, readCa, sslFor } from './database-config.mjs';
import { parseExperimentArgs } from './experiment-cli.mjs';
import { compareSchemaMetadata, isGeneratedColumn, readSchemaMetadata, selectRowList } from './schema-metadata.mjs';
import { assertRecoveryLease } from './recovery.mjs';

export const REQUIRED_TABLES = [
  'experiment', 'study', 'diaries', 'user', 'user_on_question',
];

export const OPTIONAL_TABLES = [
  'diary_time_window_map', 'experiment_onboarding_questions', 'experiment_variable_labels',
  'study_notifications', 'notifications', 'diary_notification_map', 'question_bank',
  'diary_question_map', 'diary_notifications', 'questions', 'options', 'user_diary_version',
];

export const COPY_ORDER = [
  'experiment', 'study', 'diaries', 'diary_time_window_map',
  'experiment_onboarding_questions', 'experiment_variable_labels',
  'study_notifications', 'notifications', 'question_bank',
  'diary_notifications', 'questions', 'options',
  'diary_notification_map', 'diary_question_map', 'user', 'user_diary_version', 'user_on_question',
];

const backtick = String.fromCharCode(96);
const quoteIdentifier = value =>
  backtick + String(value).replaceAll(backtick, backtick.repeat(2)) + backtick;
const markers = values => values.map(() => '?').join(', ');

// Table definitions per connection, so row reads name every column and read FLOAT values exactly.
const exactReads = new WeakMap();
export function registerExactReads(connection, metadata) { exactReads.set(connection, metadata); }
const rowList = (connection, table) => {
  const definition = exactReads.get(connection)?.get(table);
  return definition ? selectRowList(definition) : '*';
};

export function invalidParticipantQuestionLink(
  row, experimentId, legacyQuestionIds, questionMapIds,
) {
  if (row.experiment_id != null
      && String(row.experiment_id) !== String(experimentId)) return true;
  if (row.question_id == null && row.diary_question_map_id == null) return true;
  if (row.question_id != null
      && !legacyQuestionIds.has(String(row.question_id))) return true;
  if (row.diary_question_map_id != null
      && !questionMapIds.has(String(row.diary_question_map_id))) return true;
  return false;
}

async function select(connection, table, clause, values = []) {
  const [rows] = await connection.query(
    `SELECT ${rowList(connection, table)} FROM ${quoteIdentifier(table)} WHERE ${clause}`,
    values,
  );
  return rows;
}

async function selectIn(connection, table, column, values, extraClause = '', extraValues = []) {
  if (values.length === 0) return [];
  return select(connection, table,
    `${quoteIdentifier(column)} IN (${markers(values)})${extraClause}`,
    [...values, ...extraValues]);
}

export async function loadExperimentRows(connection, experimentId, availableTables) {
  const rows = new Map();
  const available = new Set(availableTables);
  const optionalSelect = (table, clause, values) => available.has(table)
    ? select(connection, table, clause, values) : [];
  const optionalSelectIn = (table, column, values) => available.has(table)
    ? selectIn(connection, table, column, values) : [];
  const experiment = await select(connection, 'experiment', 'experiment_id = ?', [experimentId]);
  if (experiment.length !== 1) throw new Error(`Source experiment ${experimentId} was not found.`);
  rows.set('experiment', experiment);

  const studies = await select(connection, 'study', 'experiment_id = ?', [experimentId]);
  rows.set('study', studies);
  const studyIds = studies.map(row => row.study_id);
  const diaries = await selectIn(connection, 'diaries', 'study_id', studyIds);
  rows.set('diaries', diaries);
  const diaryIds = diaries.map(row => row.diary_id);

  const windows = await optionalSelectIn('diary_time_window_map', 'diary_id', diaryIds);
  rows.set('diary_time_window_map', windows);
  rows.set('experiment_onboarding_questions', await optionalSelect(
    'experiment_onboarding_questions', 'experiment_id = ?', [experimentId]));
  rows.set('experiment_variable_labels', await optionalSelect(
    'experiment_variable_labels', 'experiment_id = ?', [experimentId]));
  rows.set('study_notifications',
    await optionalSelectIn('study_notifications', 'study_id', studyIds));

  const notifications = await optionalSelect('notifications', 'experiment_id = ?', [experimentId]);
  rows.set('notifications', notifications);
  const notificationIds = new Set(notifications.map(row => String(row.notification_id)));
  const notificationLinks = await optionalSelectIn(
    'diary_notification_map', 'diary_id', diaryIds);
  if (notificationLinks.some(row => !notificationIds.has(String(row.notification_id)))) {
    throw new Error('Selected diary references a notification outside the experiment.');
  }
  const windowIds = new Set(windows.map(row => String(row.diary_time_window_id)));
  if (notificationLinks.some(row => row.diary_time_window_id != null
      && !windowIds.has(String(row.diary_time_window_id)))) {
    throw new Error('Selected diary notification references a window outside the experiment.');
  }
  const selectedDiaryIds = new Set(diaryIds.map(String));
  const allNotificationLinks = await optionalSelectIn(
    'diary_notification_map', 'notification_id', [...notificationIds]);
  if (allNotificationLinks.some(row => !selectedDiaryIds.has(String(row.diary_id)))) {
    throw new Error('Experiment notification is linked to a diary outside the experiment.');
  }
  rows.set('diary_notification_map', notificationLinks);

  const questionBank = await optionalSelect('question_bank', 'experiment_id = ?', [experimentId]);
  rows.set('question_bank', questionBank);
  const questionBankIds = new Set(questionBank.map(row => String(row.question_bank_id)));
  const questionMaps = await optionalSelectIn('diary_question_map', 'diary_id', diaryIds);
  if (questionMaps.some(row =>
    row.question_bank_id != null
      && !questionBankIds.has(String(row.question_bank_id)))) {
    throw new Error('Selected diary references a question bank outside the experiment.');
  }
  const allQuestionLinks = await optionalSelectIn(
    'diary_question_map', 'question_bank_id', [...questionBankIds]);
  if (allQuestionLinks.some(row => !selectedDiaryIds.has(String(row.diary_id)))) {
    throw new Error('Experiment question bank is linked to a diary outside the experiment.');
  }
  rows.set('diary_question_map', questionMaps);

  const users = await select(connection, 'user', 'experimentid = ?', [experimentId]);
  rows.set('user', users);
  if (available.has('user_diary_version')) {
    rows.set('user_diary_version', await selectIn(connection, 'user_diary_version', 'user_id',
      users.map(row => row.user_id)));
  }
  rows.set('user_on_question', await selectIn(connection, 'user_on_question', 'user_id',
    users.map(row => row.user_id)));

  if (availableTables.includes('diary_notifications')) {
    rows.set('diary_notifications',
      await selectIn(connection, 'diary_notifications', 'diary_id', diaryIds));
  }
  let legacyQuestions = [];
  if (availableTables.includes('questions')) {
    legacyQuestions = await selectIn(connection, 'questions', 'diary_id', diaryIds);
    rows.set('questions', legacyQuestions);
  }
  if (availableTables.includes('options')) {
    rows.set('options', await selectIn(connection, 'options', 'question_id',
      legacyQuestions.map(row => row.question_id)));
  }
  const legacyQuestionIds = new Set(
    legacyQuestions.map(row => String(row.question_id)));
  const questionMapIds = new Set(
    questionMaps.map(row => String(row.diary_question_map_id)));
  if (rows.get('user_on_question').some(row =>
    invalidParticipantQuestionLink(
      row, experimentId, legacyQuestionIds, questionMapIds))) {
    throw new Error('Participant question links reference records outside the experiment.');
  }
  return new Map([...rows].filter(([table]) => available.has(table)));
}

export function orderSelectedTables(metadata, tables) {
  const remaining = new Set(tables);
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter(table =>
      metadata.get(table).keys.every(key =>
        !key.REFERENCED_TABLE_NAME || !remaining.has(key.REFERENCED_TABLE_NAME)));
    if (!ready.length) {
      throw new Error(`Foreign-key cycle in experiment tables: ${[...remaining].join(', ')}`);
    }
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

export async function findUnhandledDependents(connection, schema, selectedTables) {
  const values = [...new Set(selectedTables)];
  const markers = values.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT DISTINCT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_SCHEMA = ?
        AND REFERENCED_TABLE_NAME IN (${markers})
      ORDER BY TABLE_NAME`,
    [schema, schema, ...values],
  );
  return rows.map(row => row.TABLE_NAME).filter(name => !values.includes(name));
}

export function findMissingSelectedParents(sourceRows, metadata, tableOrder) {
  const selected = new Set(tableOrder);
  const missing = [];
  for (const table of tableOrder) {
    const groups = new Map();
    for (const key of metadata.get(table).keys) {
      if (!key.REFERENCED_TABLE_NAME || !selected.has(key.REFERENCED_TABLE_NAME)) continue;
      if (!groups.has(key.CONSTRAINT_NAME)) groups.set(key.CONSTRAINT_NAME, []);
      groups.get(key.CONSTRAINT_NAME).push(key);
    }
    for (const [constraint, parts] of groups) {
      parts.sort((left, right) => left.ORDINAL_POSITION - right.ORDINAL_POSITION);
      const parents = sourceRows.get(parts[0].REFERENCED_TABLE_NAME) || [];
      for (const row of sourceRows.get(table) || []) {
        const values = parts.map(part => row[part.COLUMN_NAME]);
        if (values.some(value => value == null)) continue;
        const found = parents.some(parent => parts.every((part, index) =>
          isDeepStrictEqual(comparable(parent[part.REFERENCED_COLUMN_NAME]),
            comparable(values[index]))));
        if (!found) missing.push({ table, constraint,
          referencedTable: parts[0].REFERENCED_TABLE_NAME });
      }
    }
  }
  return missing;
}

function comparable(value) {
  if (Buffer.isBuffer(value)) return { buffer: value.toString('base64') };
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value === 'bigint') return { bigint: value.toString() };
  return value;
}

function keyFor(row, primaryKey) {
  return JSON.stringify(primaryKey.map(column => comparable(row[column])));
}

function rowsEqual(left, right, columns) {
  return columns.every(column =>
    isDeepStrictEqual(comparable(left[column]), comparable(right[column])));
}

async function targetRowsByIdentity(connection, table, identityKey, sourceRows) {
  const found = new Map();
  for (const row of sourceRows) {
    const clause = identityKey.map(column => `${quoteIdentifier(column)} <=> ?`).join(' AND ');
    const [rows] = await connection.query(
      `SELECT ${rowList(connection, table)} FROM ${quoteIdentifier(table)} WHERE ${clause}`,
      identityKey.map(column => row[column]),
    );
    if (rows.length > 1) throw new Error(`Identity lookup returned multiple rows in ${table}.`);
    if (rows[0]) found.set(keyFor(row, identityKey), rows[0]);
  }
  return found;
}

export async function findMissingExternalDependencies(
  target, sourceRows, metadata, tableOrder, source,
) {
  const selectedTables = new Set(tableOrder);
  const missing = [];
  const checked = new Map();
  for (const table of tableOrder) {
    const foreignKeys = new Map();
    for (const key of metadata.get(table).keys) {
      if (!key.REFERENCED_TABLE_NAME || selectedTables.has(key.REFERENCED_TABLE_NAME)) continue;
      if (!foreignKeys.has(key.CONSTRAINT_NAME)) foreignKeys.set(key.CONSTRAINT_NAME, []);
      foreignKeys.get(key.CONSTRAINT_NAME).push(key);
    }
    for (const [constraint, parts] of foreignKeys) {
      parts.sort((left, right) => left.ORDINAL_POSITION - right.ORDINAL_POSITION);
      for (const row of sourceRows.get(table) || []) {
        const values = parts.map(part => row[part.COLUMN_NAME]);
        if (values.some(value => value == null)) continue;
        const clause = parts.map(part =>
          `${quoteIdentifier(part.REFERENCED_COLUMN_NAME)} <=> ?`).join(' AND ');
        if (!source) throw new Error('External parent content verification requires the source connection.');
        if (parts.some(part => part.REFERENCED_TABLE_SCHEMA
            && part.REFERENCED_TABLE_SCHEMA !== '@local')) {
          throw new Error('Cross-schema experiment parents require explicit mapping and review.');
        }
        const parent = parts[0].REFERENCED_TABLE_NAME;
        const lookup = connection =>
          `SELECT ${rowList(connection, parent)} FROM ${quoteIdentifier(parent)} WHERE ${clause} LIMIT 2`;
        const cacheKey = JSON.stringify([lookup(source), lookup(target), values.map(comparable)]);
        if (!checked.has(cacheKey)) {
          checked.set(cacheKey, [await source.query(lookup(source), values), await target.query(lookup(target), values)]);
        }
        const [[expected], [found]] = checked.get(cacheKey);
        if (expected.length !== 1 || found.length !== 1
            || !isDeepStrictEqual(Object.keys(expected[0]).sort(), Object.keys(found[0]).sort())
            || !rowsEqual(expected[0], found[0], Object.keys(expected[0]))) {
          missing.push({
            table,
            constraint,
            referencedTable: parts[0].REFERENCED_TABLE_NAME,
            values: values.map(comparable),
            reason: expected.length !== 1 ? 'Source parent is missing or ambiguous'
              : found.length !== 1 ? 'Target parent is missing or ambiguous' : 'Parent content differs',
          });
        }
      }
    }
  }
  return missing;
}

export async function buildExperimentPlan(target, sourceRows, metadata, tableOrder, source) {
  const tables = [];
  const conflicts = [];
  for (const table of tableOrder) {
    const rows = sourceRows.get(table) || [];
    const definition = metadata.get(table);
    const writableColumns = definition.columns
      .filter(column => !isGeneratedColumn(column))
      .map(column => column.COLUMN_NAME);
    const existing = await targetRowsByIdentity(target, table, definition.identityKey, rows);
    const uniqueIndexes = [...new Set(definition.indexes
      .filter(index => Number(index.NON_UNIQUE) === 0 && index.INDEX_NAME !== 'PRIMARY')
      .map(index => index.INDEX_NAME))].map(name => definition.indexes
      .filter(index => index.INDEX_NAME === name)
      .sort((left, right) => left.SEQ_IN_INDEX - right.SEQ_IN_INDEX));
    let identical = 0;
    let pending = 0;
    for (const row of rows) {
      const found = existing.get(keyFor(row, definition.identityKey));
      if (!found) {
        pending++;
        for (const index of uniqueIndexes) {
          const values = index.map(part => row[part.COLUMN_NAME]);
          if (values.some(value => value == null)) continue;
          const clause = index.map(part =>
            `${quoteIdentifier(part.COLUMN_NAME)} = ?`).join(' AND ');
          const [collisions] = await target.query(
            `SELECT ${definition.identityKey.map(quoteIdentifier).join(', ')}
               FROM ${quoteIdentifier(table)} WHERE ${clause} LIMIT 1`,
            values,
          );
          if (collisions.length && keyFor(collisions[0], definition.identityKey)
              !== keyFor(row, definition.identityKey)) {
            conflicts.push({
              table, uniqueIndex: index[0].INDEX_NAME,
              identity: Object.fromEntries(
                definition.identityKey.map(column => [column, comparable(row[column])])),
            });
          }
        }
      } else if (rowsEqual(row, found, writableColumns)) {
        identical++;
      } else {
        conflicts.push({
          table,
          identity: Object.fromEntries(
            definition.identityKey.map(column => [column, comparable(row[column])])),
        });
      }
    }
    tables.push({ table, source: rows.length, pending, identical });
  }
  const missingExternalDependencies = await findMissingExternalDependencies(
    target, sourceRows, metadata, tableOrder, source);
  const missingSelectedParents = findMissingSelectedParents(sourceRows, metadata, tableOrder);
  return { tables, conflicts, missingExternalDependencies, missingSelectedParents };
}

export async function insertPendingRows(target, sourceRows, metadata, tableOrder) {
  const inserted = {};
  for (const table of tableOrder) {
    const definition = metadata.get(table);
    const columns = definition.columns
      .filter(column => !isGeneratedColumn(column))
      .map(column => column.COLUMN_NAME);
    const rows = sourceRows.get(table) || [];
    const existing = await targetRowsByIdentity(
      target, table, definition.identityKey, rows);
    const pending = rows.filter(row => !existing.has(keyFor(row, definition.identityKey)))
      .map(row => columns.map(column => row[column]));
    const { insertPreparedRows } = await import('./prepared-batches.mjs');
    await insertPreparedRows(target, table, columns, pending);
    inserted[table] = pending.length;
  }
  return inserted;
}

export function connect(config, ca, createConnection = mysql.createConnection) {
  return createConnection({
    host: config.host,
    port: config.port,
    database: config.schema,
    user: config.user,
    password: passwordFor(config),
    ssl: sslFor(config, ca),
    connectTimeout: 15000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    jsonStrings: true,
    dateStrings: true,
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseExperimentArgs(args);
  const databases = databaseConfigs();
  if (passwordFor(databases.dev) === undefined || passwordFor(databases.target) === undefined
     ) {
    throw new Error('Set both database passwords.');
  }
  if (options.execute && (options.confirmTarget !== databases.target.schema
      || options.confirmHost !== databases.target.host)) {
    throw new Error(
      `To write, confirm target ${databases.target.schema} and host ${databases.target.host}.`);
  }

  const ca = readCa();
  if (options.execute) await assertRecoveryLease(databases);
  const [source, target] = await Promise.all([
    connect(databases.dev, ca),
    connect(databases.target, ca),
  ]);
  try {
    await source.query("SET SESSION time_zone = '+00:00'");
    await target.query("SET SESSION time_zone = '+00:00'");
    await source.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await source.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const allTables = [...REQUIRED_TABLES, ...OPTIONAL_TABLES];
    const [sourceMeta, targetMeta] = await Promise.all([
      readSchemaMetadata(source, databases.dev.schema, allTables),
      readSchemaMetadata(target, databases.target.schema, allTables),
    ]);
    const availableTables = compareSchemaMetadata(sourceMeta, targetMeta,
      { required: REQUIRED_TABLES, optional: OPTIONAL_TABLES });
    // External parents (such as team) are compared by content, so they are read exactly too.
    const parents = [...new Set([...sourceMeta.values()].flatMap(table => table.keys
      .map(key => key.REFERENCED_TABLE_NAME).filter(name => name && !sourceMeta.has(name))))];
    const [sourceParents, targetParents] = await Promise.all([
      readSchemaMetadata(source, databases.dev.schema, parents),
      readSchemaMetadata(target, databases.target.schema, parents),
    ]);
    registerExactReads(source, new Map([...sourceMeta, ...sourceParents]));
    registerExactReads(target, new Map([...targetMeta, ...targetParents]));
    if ([...sourceMeta.values()].some(table => table.keys.some(key =>
      key.REFERENCED_TABLE_SCHEMA && key.REFERENCED_TABLE_SCHEMA !== '@local'))) {
      throw new Error('Cross-schema experiment foreign keys require explicit mapping and review.');
    }
    const unhandled = await findUnhandledDependents(
      source, databases.dev.schema, availableTables);
    if (unhandled.length) {
      throw new Error(`Unhandled dependent tables: ${unhandled.join(', ')}.`);
    }
    const tableOrder = orderSelectedTables(targetMeta,
      COPY_ORDER.filter(table => availableTables.includes(table)));
    let experimentIds = [...options.experimentIds];
    if (options.allExperiments) {
      const [rows] = await source.query('SELECT experiment_id FROM experiment ORDER BY experiment_id');
      for (const row of rows) experimentIds.push(row.experiment_id);
    } else {
      for (const loginCode of options.loginCodes) {
        const [rows] = await source.execute(
          'SELECT experiment_id FROM experiment WHERE researcher_logincode = ?',
          [loginCode],
        );
        if (rows.length !== 1) {
          throw new Error('A selected login code did not resolve to exactly one source experiment.');
        }
        experimentIds.push(rows[0].experiment_id);
      }
    }
    experimentIds = Array.from(
      new Map(experimentIds.map(id => [String(id), id])).values());
    if (experimentIds.length === 0) throw new Error('Source has no experiments to copy.');

    async function inspectExperiment(experimentId) {
      const sourceRows = await loadExperimentRows(source, experimentId, tableOrder);
      const [matchingLoginCodes] = await target.execute(
        'SELECT experiment_id FROM experiment WHERE researcher_logincode = ?',
        [sourceRows.get('experiment')[0].researcher_logincode],
      );
      if (matchingLoginCodes.some(row => String(row.experiment_id) !== String(experimentId))) {
        throw new Error(`Target has the login code for experiment ${experimentId} under a different ID.`);
      }
      const plan = await buildExperimentPlan(target, sourceRows, targetMeta, tableOrder, source);
      if (plan.conflicts.length || plan.missingExternalDependencies.length
          || plan.missingSelectedParents.length) {
        throw new Error(`Experiment ${experimentId} has conflicting or missing dependent rows; nothing was written. ${JSON.stringify(plan)}`);
      }
      return { sourceRows, plan };
    }

    const plans = [];
    for (const experimentId of experimentIds) {
      const { plan } = await inspectExperiment(experimentId);
      plans.push({ experimentId, ...plan });
    }
    const summary = {
      action: options.allExperiments ? 'all-experiments' : 'selected-experiments',
      from: databases.dev.schema,
      to: databases.target.schema,
      host: databases.target.host,
      executed: false,
      experiments: plans,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!options.execute) return summary;

    await target.beginTransaction();
    try {
      const inserted = [];
      for (const experimentId of experimentIds) {
        const { sourceRows } = await inspectExperiment(experimentId);
        const counts = await insertPendingRows(target, sourceRows, targetMeta, tableOrder);
        const verification = await buildExperimentPlan(target, sourceRows, targetMeta, tableOrder, source);
        if (verification.conflicts.length || verification.missingSelectedParents.length
            || verification.missingExternalDependencies.length
            || verification.tables.some(table => table.pending !== 0)) {
          throw new Error(`Post-copy verification failed for experiment ${experimentId}.`);
        }
        inserted.push({ experimentId, tables: counts });
      }
      await target.commit();
      const result = { ...summary, executed: true, inserted };
      console.log(JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      await target.rollback();
      throw error;
    }
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
