import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { quoteIdentifier } from './copy-data.mjs';
import { databaseConfigs, passwordFor, readCa, sslFor } from './database-config.mjs';
import { assertConfirmedTarget, parseWriteOptions } from './write-options.mjs';
import { assertRecoveryLease } from './recovery.mjs';

const databases = databaseConfigs();

export function useCurrentDefiner(createSql) {
  const prefix = /^CREATE\s+DEFINER\s*=\s*(?:`(?:``|[^`])*`|'(?:''|[^'])*'|[^@\s]+)@(?:`(?:``|[^`])*`|'(?:''|[^'])*'|[^\s]+)\s+(?=PROCEDURE\b)/i;
  if (!prefix.test(createSql)) throw new Error('Unexpected stored procedure definition; review it manually.');
  return createSql.replace(prefix, 'CREATE DEFINER=CURRENT_USER ');
}

export function referencesSchema(createSql, schema) {
  const escaped = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\`${escaped}\`|\\b${escaped}\\b)\\s*\\.`, 'i').test(createSql);
}

export function procedureHash(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

export function procedureDefiner(env = process.env) {
  const user = env.MIGRATION_PROCEDURE_DEFINER_USER;
  const host = env.MIGRATION_PROCEDURE_DEFINER_HOST;
  if (user === undefined && host === undefined) return undefined;
  if (![user, host].every(value => typeof value === 'string' && value.length > 0
      && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value))) {
    throw new Error('Set both procedure definer overrides, or leave both unset to use the existing target account.');
  }
  return { user, host };
}

export async function resolveProcedureDefiner(target, env = process.env) {
  const override = procedureDefiner(env);
  if (override) return override;
  const [[row]] = await target.query('SELECT CURRENT_USER() AS account');
  const account = row?.account;
  const separator = typeof account === 'string' ? account.lastIndexOf('@') : -1;
  if (separator <= 0) throw new Error('Cannot identify the existing target procedure account.');
  return procedureDefiner({ MIGRATION_PROCEDURE_DEFINER_USER: account.slice(0, separator),
    MIGRATION_PROCEDURE_DEFINER_HOST: account.slice(separator + 1) });
}

export function prepareProcedure(row, definer) {
  if (!procedureDefiner({ MIGRATION_PROCEDURE_DEFINER_USER: definer?.user,
    MIGRATION_PROCEDURE_DEFINER_HOST: definer?.host })) {
    throw new Error('A resolved target procedure account is required.');
  }
  const sqlMode = row.sql_mode;
  if (typeof sqlMode !== 'string' || !/^[A-Z0-9_,]*$/.test(sqlMode)) {
    throw new Error('Cannot verify the source procedure SQL mode.');
  }
  const sql = useCurrentDefiner(row['Create Procedure'])
    .replace(/^CREATE DEFINER=CURRENT_USER /,
      () => `CREATE DEFINER=${quoteIdentifier(definer.user)}@${quoteIdentifier(definer.host)} `);
  return { sql, sqlMode, definer, sha256: procedureHash(sql) };
}

export function approvedProcedure(policy, name, sql, context) {
  const approval = policy[name];
  return Boolean(context && approval?.sha256 === procedureHash(sql)
    && approval.sqlMode === context.sqlMode
    && approval.definer?.user === context.definer?.user
    && approval.definer?.host === context.definer?.host
    && (!context.identity || approval.identity === context.identity));
}

export async function applyApprovedProcedure(target, name, definition, policy) {
  if (prepareProcedure({ 'Create Procedure': definition.sql, sql_mode: definition.sqlMode },
    definition.definer).sql !== definition.sql) {
    throw new Error(`Procedure ${name} SQL does not specify the approved definer.`);
  }
  if (!approvedProcedure(policy, name, definition.sql, definition)) {
    throw new Error(`Procedure ${name} requires approval of its exact SQL, definer and SQL mode.`);
  }
  const [[original]] = await target.query('SELECT @@SESSION.sql_mode AS sqlMode');
  try {
    await target.query('SET SESSION sql_mode = ?', [definition.sqlMode]);
    await target.query(definition.sql);
    const [[actual]] = await target.query(`SHOW CREATE PROCEDURE ${quoteIdentifier(name)}`);
    if (actual['Create Procedure'] !== definition.sql || actual.sql_mode !== definition.sqlMode) {
      throw new Error(`Procedure ${name} verification failed after creation.`);
    }
  } finally {
    await target.query('SET SESSION sql_mode = ?', [original.sqlMode]);
  }
}

async function procedures(connection, schema) {
  const [rows] = await connection.execute(
    "SELECT ROUTINE_NAME, ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME",
    [schema],
  );
  if (rows.some(row => row.ROUTINE_DEFINITION == null)) {
    throw new Error('Cannot read a procedure definition. Grant SHOW ROUTINE before copying procedures.');
  }
  return rows;
}

export function procedureIdentity(configs) {
  return JSON.stringify([configs.dev, configs.target].map(({ host, port, schema, user }) =>
    ({ host, port, schema, user })));
}

export async function inspectProcedureCopy(source, target, configs, policy = {}, env = process.env) {
  const definer = await resolveProcedureDefiner(target, env);
  const identity = procedureIdentity(configs);
  const sourceProcedures = await procedures(source, configs.dev.schema);
  const targetProcedures = await procedures(target, configs.target.schema);
  const excludedObjects = await otherDatabaseObjects(source, configs.dev.schema);
  const existing = new Set(targetProcedures.map(row => row.ROUTINE_NAME));
  const pending = [];
  for (const procedure of sourceProcedures) {
    const name = procedure.ROUTINE_NAME;
    const [rows] = await source.query(`SHOW CREATE PROCEDURE ${quoteIdentifier(name)}`);
    const definition = { ...prepareProcedure(rows[0], definer), identity };
    if (referencesSchema(definition.sql, configs.dev.schema)) {
      throw new Error(`Procedure ${name} names the source schema explicitly; review it before copying.`);
    }
    if (existing.has(name)) {
      const [targetRows] = await target.query(`SHOW CREATE PROCEDURE ${quoteIdentifier(name)}`);
      if (targetRows[0]['Create Procedure'] !== definition.sql || targetRows[0].sql_mode !== definition.sqlMode) {
        throw new Error(`Procedure ${name} differs on target; refusing to overwrite it.`);
      }
      continue;
    }
    pending.push({ name, ...definition, approved: approvedProcedure(policy, name, definition.sql, definition) });
  }
  return { identity, definer, existing: sourceProcedures.length - pending.length, pending, excludedObjects };
}

export async function otherDatabaseObjects(connection, schema) {
  const [[functions], [triggers], [views], [events]] = await Promise.all([
    connection.execute(
      "SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME",
      [schema],
    ),
    connection.execute(
      'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',
      [schema],
    ),
    connection.execute(
      "SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [schema],
    ),
    connection.execute(
      'SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME',
      [schema],
    ),
  ]);
  return {
    functions: functions.map(row => row.name),
    triggers: triggers.map(row => row.name),
    views: views.map(row => row.name),
    events: events.map(row => row.name),
  };
}

async function main() {
  const usage = 'Usage: node copy-procedures.mjs [--execute --confirm-target NAME --confirm-host HOST]';
  const options = parseWriteOptions(process.argv.slice(2), usage);
  const execute = options.execute;
  assertConfirmedTarget(options, databases.target);
  if (options.execute) await assertRecoveryLease(databases);
  if (passwordFor(databases.dev) === undefined || passwordFor(databases.target) === undefined) {
    throw new Error('Set MIGRATION_DB_PASSWORD (or both database passwords).');
  }
  const ca = readCa();
  const policy = JSON.parse(readFileSync(
    new URL('procedure-policy.json', import.meta.url), 'utf8'));
  const connect = config => mysql.createConnection({
    host: config.host, port: config.port, database: config.schema, user: config.user,
    password: passwordFor(config), ssl: sslFor(config, ca),
    connectTimeout: 15000,
  });
  const connections = [];
  const created = [];
  try {
    connections.push(await connect(databases.dev));
    connections.push(await connect(databases.target));
    const [source, target] = connections;
    const plan = await inspectProcedureCopy(source, target, databases, policy);
    const todo = plan.pending;
    console.log(JSON.stringify({ action: 'stored-procedures', executed: false, ...plan }, null, 2));
    if (!execute && !options.strictPreview) return;
    const unapproved = todo.filter(item => !item.approved).map(item => item.name);
    if (unapproved.length) {
      throw new Error(`Unreviewed procedure definitions: ${unapproved.join(', ')}. Run npm run migration:interactive and approve the procedure preview with y.`);
    }
    if (!execute) return;
    for (const item of todo) {
      await applyApprovedProcedure(target, item.name, item, policy);
      created.push(item.name);
      console.log(JSON.stringify({ createdProcedure: item.name }));
    }
    console.log(JSON.stringify({ action: 'stored-procedures', executed: true, created }));
  } catch (error) {
    throw new Error(`${error.message} Procedures already created: ${created.join(', ') || 'none'}.`);
  } finally {
    await Promise.allSettled(connections.map(connection => connection.end()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
