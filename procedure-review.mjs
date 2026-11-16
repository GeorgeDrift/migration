import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, openSync, closeSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { passwordFor, readCa, sslFor } from './database-config.mjs';
import { inspectProcedureCopy, procedureIdentity } from './copy-procedures.mjs';

const defaultRoot = fileURLToPath(new URL('.', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = plan => hash(JSON.stringify({ ...plan,
  pending: plan.pending.map(({ approved, ...definition }) => definition) }));

function readPolicy(root) {
  const text = readFileSync(join(root, 'procedure-policy.json'), 'utf8');
  const policy = JSON.parse(text);
  if (!policy || Array.isArray(policy) || typeof policy !== 'object') {
    throw new Error('Invalid procedure policy; no approval was saved.');
  }
  return { text, policy };
}

async function livePlan(configs, policy, env = process.env) {
  if (passwordFor(configs.dev, env) === undefined || passwordFor(configs.target, env) === undefined) {
    throw new Error('Set database connection passwords. No separate procedure password is needed.');
  }
  const ca = readCa(env);
  const connections = [];
  try {
    for (const config of [configs.dev, configs.target]) {
      connections.push(await mysql.createConnection({ host: config.host, port: config.port,
        database: config.schema, user: config.user, password: passwordFor(config, env),
        ssl: sslFor(config, ca), connectTimeout: 15000 }));
    }
    return await inspectProcedureCopy(connections[0], connections[1], configs, policy, env);
  } finally {
    await Promise.allSettled(connections.map(connection => connection.end()));
  }
}

export async function proposeProcedureReview(configs, { root = defaultRoot, inspect = livePlan } = {}) {
  const before = readPolicy(root);
  const plan = await inspect(configs, before.policy);
  if (readPolicy(root).text !== before.text) throw new Error('Procedure approvals changed; preview again.');
  return { plan, fingerprint: fingerprint(plan), policyHash: hash(before.text) };
}

export async function approveProcedureReview(proposal, configs, { root = defaultRoot, inspect = livePlan } = {}) {
  if (proposal.plan.identity !== procedureIdentity(configs) || fingerprint(proposal.plan) !== proposal.fingerprint) {
    throw new Error('Procedure preview or target changed; approval cancelled.');
  }
  const lockPath = join(root, '.procedure-review.lock');
  const lock = openSync(lockPath, 'wx', 0o600);
  const temporary = join(root, `.procedure-policy-${randomUUID()}.tmp`);
  try {
    const before = readPolicy(root);
    if (hash(before.text) !== proposal.policyHash) throw new Error('Procedure policy changed; preview again.');
    const current = await inspect(configs, before.policy);
    if (fingerprint(current) !== proposal.fingerprint) {
      throw new Error('Live procedure definitions or target account changed; approval cancelled.');
    }
    if (readPolicy(root).text !== before.text) throw new Error('Procedure policy changed during approval.');
    const entries = current.pending.map(({ name, sha256, definer, sqlMode, identity }) =>
      [name, { sha256, definer, sqlMode, identity }]);
    writeFileSync(temporary, JSON.stringify({ ...before.policy, ...Object.fromEntries(entries) }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    renameSync(temporary, join(root, 'procedure-policy.json'));
    return { approved: entries.map(([name]) => name), definer: current.definer };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
