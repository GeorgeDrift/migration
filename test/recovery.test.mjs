import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRecoveryLease, clientOptions, createRecovery, dumpArguments, listCheckpoints,
  readCheckpoint, recoveryTimeouts, selectCheckpoint, validateIdentity,
} from '../recovery.mjs';
import { parseRollbackArgs } from '../rollback.mjs';

const databases = {
  dev: { host: 'test-host', port: 3306, schema: 'migration_dev', user: 'admin', passwordKey: 'DEV_DB_PASSWORD' },
  target: { host: 'test-host', port: 3306, schema: 'migration_target', user: 'admin', passwordKey: 'TARGET_DB_PASSWORD' },
};

async function fixture(run, settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fabla-recovery-'));
  const env = {
    MIGRATION_RECOVERY_DIR: root, MIGRATION_RECOVERY_S3_URI: 's3://private-test-bucket/recovery',
    MIGRATION_MAINTENANCE_TARGET: 'migration_target', TARGET_DB_PASSWORD: 'private-password',
    RDS_CA_BUNDLE: '/test/ca.pem',
  };
  if (settings.local) Object.assign(env, { MIGRATION_LOCAL_ONLY: '1', MIGRATION_DB_HOST: '127.0.0.1', TARGET_DB_PASSWORD: '', RDS_CA_BUNDLE: undefined, MIGRATION_RECOVERY_S3_URI: undefined });
  const selectedDatabases = settings.local ? { dev: { ...databases.dev, host: '127.0.0.1' }, target: { ...databases.target, host: '127.0.0.1' } } : databases;
  const remote = new Map();
  const commands = [];
  let state = 'initial target schema, records and Atlas history';
  let ended = false;
  const db = {
    async execute(sql) {
      if (sql.includes('GET_LOCK')) return [[{ acquired: settings.locked ? 0 : 1, owner: '17' }]];
      if (sql.includes('IS_USED_LOCK')) return [[{ owner: settings.loseLockAfterDump
        && commands.some(command => command.binary === 'mariadb-dump') ? null : '17' }]];
      if (sql.includes('KEY_COLUMN_USAGE')) return [settings.crossSchema ? [{ TABLE_NAME: 'foreign' }] : []];
      if (sql.includes('information_schema.TABLES')) return [settings.nonTransactional ? [{ TABLE_NAME: 'legacy' }] : []];
      if (sql.includes('information_schema.EVENTS')) return [settings.events ? [{ EVENT_NAME: 'scheduled' }] : []];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      throw new Error('Unexpected query: ' + sql);
    },
    async end() { ended = true; },
  };
  function spawn(binary, args, options) {
    commands.push({ binary, args, timeout: options.timeout });
    assert.equal(options.shell, false);
    assert.ok(args.every(arg => !arg.includes('private-password')));
    if (binary === 'mariadb-dump') {
      if (settings.dumpFails) return { status: 1 };
      writeSync(options.stdio[1], state);
    } else if (binary === 'mariadb') {
      if (settings.restoreFails) return { status: 1 };
      state = readFileSync(options.stdio[0], 'utf8');
      if (settings.badRestore) state += ' wrong state';
    } else if (binary === 'aws') {
      if (settings.uploadFails) return { status: 1 };
      const [from, to] = args.slice(2, 4);
      if (from.startsWith('s3://')) writeFileSync(to, settings.corruptDownload ? 'corrupt' : remote.get(from));
      else remote.set(to, readFileSync(from));
    } else throw new Error('Unexpected external command');
    return { status: 0, stdout: '', stderr: '' };
  }
  const dependencies = { env, connect: async () => db, spawn, print: () => {} };
  let recovery;
  try {
    await run({ root, env, commands, remote, dependencies,
      open: async () => (recovery = await createRecovery(selectedDatabases, settings.local ? null : Buffer.from('CA'), dependencies)),
      setState: value => { state = value; }, getState: () => state, ended: () => ended });
  } finally {
    if (recovery) await recovery.close();
    // This fixture creates only files in its unique temp directory; do not recurse.
    for (const name of readdirSync(root)) unlinkSync(join(root, name));
    rmdirSync(root);
  }
}

test('checkpoints are uploaded, downloaded and verified before a write lease is issued', async () => {
  await fixture(async ({ open, env, remote, root }) => {
    const recovery = await open();
    const record = await recovery.checkpoint('Before schema');
    assert.equal(remote.size, 2);
    assert.equal(readCheckpoint(root, record.id, databases).label, 'Before schema');
    assert.equal(JSON.parse(env.MIGRATION_RECOVERY_LEASE).id, record.id);
  });
});

test('restore replaces target state and verifies it against the saved checksum', async () => {
  await fixture(async ({ open, setState, getState, root }) => {
    const recovery = await open();
    const record = await recovery.checkpoint('Before schema');
    setState('partially changed target');
    await recovery.restore(record);
    assert.equal(getState(), 'initial target schema, records and Atlas history');
    assert.equal(listCheckpoints(root, databases).length, 1);
    assert.equal(readdirSync(root).filter(name => name.endsWith('.json')).length, 2);
  });
});

test('one, two and three checkpoint selection is explicit and missing history is rejected', () => {
  const records = [{ id: 'newest' }, { id: 'middle' }, { id: 'oldest' }];
  assert.equal(selectCheckpoint(records, 1).id, 'newest');
  assert.equal(selectCheckpoint(records, 2).id, 'middle');
  assert.equal(selectCheckpoint(records, 3).id, 'oldest');
  assert.throws(() => selectCheckpoint(records, 4), /1, 2, or 3/);
  assert.throws(() => selectCheckpoint(records.slice(0, 1), 3), /Only 1/);
});

test('tampered checkpoint SQL and mismatched target cannot restore', async () => {
  await fixture(async ({ open, root, commands }) => {
    const recovery = await open();
    const record = await recovery.checkpoint('Before data');
    assert.throws(() => validateIdentity(record, { ...databases,
      target: { ...databases.target, schema: 'migration_dev' } }), /source restoration is forbidden/);
    writeFileSync(join(root, record.id + '.sql'), 'tampered');
    await assert.rejects(recovery.restore(record), /checksum differs/);
    assert.ok(!commands.some(command => command.binary === 'mariadb'));
    assert.throws(() => readCheckpoint(root, '../source', databases), /Invalid checkpoint/);
  });
});

test('backup or durable upload failure does not issue a write lease', async () => {
  for (const settings of [{ dumpFails: true }, { uploadFails: true }, { corruptDownload: true },
    { loseLockAfterDump: true }]) {
    await fixture(async ({ open, env }) => {
      const recovery = await open();
      await assert.rejects(recovery.checkpoint('Before data'));
      assert.equal(env.MIGRATION_RECOVERY_LEASE, undefined);
    }, settings);
  }
});

test('restore failure and verification mismatch are not reported as successful rollback', async () => {
  for (const settings of [{ restoreFails: true }, { badRestore: true }]) {
    await fixture(async ({ open, setState }) => {
      const recovery = await open();
      const record = await recovery.checkpoint('Before schema');
      setState('partial changes');
      await assert.rejects(recovery.restore(record), /Restore failed|does not reproduce checkpoint/);
    }, settings);
  }
});

test('cross-schema references, events and nontransactional tables block automatic recovery', async () => {
  for (const settings of [{ crossSchema: true }, { events: true }, { nonTransactional: true }, { locked: true }]) {
    await fixture(async ({ open, commands, ended }) => {
      await assert.rejects(open());
      assert.equal(commands.length, 0);
      assert.equal(ended(), true);
    }, settings);
  }
});

test('maintenance acknowledgement and durable backup destination are mandatory', async () => {
  await fixture(async ({ dependencies, env }) => {
    delete env.MIGRATION_MAINTENANCE_TARGET;
    await assert.rejects(createRecovery(databases, Buffer.alloc(0), dependencies), /Pause all target writers/);
    env.MIGRATION_MAINTENANCE_TARGET = 'migration_target';
    delete env.MIGRATION_RECOVERY_S3_URI;
    await assert.rejects(createRecovery(databases, Buffer.alloc(0), dependencies), /Durable recovery is required/);
  });
});

test('unprotected standalone writes are refused before any connection', async () => {
  await assert.rejects(assertRecoveryLease(databases, {}), /protected checkpoint/);
});

test('client defaults escape credentials and dump is scoped to exactly the target schema', () => {
  const options = clientOptions(databases.target, 'a"b\\c\npassword', '/ca.pem');
  assert.match(options, /password="a\\"b\\\\c\\npassword"/);
  const args = dumpArguments('/private/client.cnf', 'migration_target');
  assert.deepEqual(args.slice(-2), ['--databases', 'migration_target']);
  assert.ok(args.includes('--routines'));
  assert.ok(args.includes('--triggers'));
  assert.ok(args.includes('--add-drop-database'));
  assert.ok(!args.includes('--all-databases'));
});

test('rollback is preview-only unless complete write confirmation is supplied', () => {
  assert.equal(parseRollbackArgs(['restore', '--steps', '3']).execute, false);
  assert.throws(() => parseRollbackArgs(['restore', '--execute']), /confirmation/);
  assert.throws(() => parseRollbackArgs(['restore', '--steps', '0']), /1, 2, or 3/);
  assert.throws(() => parseRollbackArgs(['restore', '--steps', '1', '--steps', '2']), /Repeated/);
  assert.throws(() => parseRollbackArgs(['list', '--execute']), /read-only/);
});

test('shared client defaults omit the timeout option unsupported by mariadb-dump', () => {
  const options = clientOptions(databases.target, 'private-password', '/ca.pem');
  assert.doesNotMatch(options, /connect[-_]timeout/i);
  assert.ok(options.includes('ssl-ca='));
  assert.ok(options.includes('ssl-verify-server-cert='));
  assert.ok(dumpArguments('/private/client.cnf', 'migration_target')
    .every(arg => !/connect[-_]timeout/i.test(arg)));
});

test('backup, restore and S3 subprocess timeouts are validated and independently configurable', async () => {
  assert.deepEqual(recoveryTimeouts({}), { dump: 300000, restore: 300000, s3: 300000 });
  for (const value of ['0', '-1', 'NaN', '300000ms', '86400001', '1.5']) {
    assert.throws(() => recoveryTimeouts({ MIGRATION_DUMP_TIMEOUT_MS: value }), /integer from/);
  }
  await fixture(async ({ env, open, commands, setState }) => {
    Object.assign(env, { MIGRATION_DUMP_TIMEOUT_MS: '600000', MIGRATION_RESTORE_TIMEOUT_MS: '900000',
      MIGRATION_S3_TIMEOUT_MS: '450000' });
    const recovery = await open();
    const record = await recovery.checkpoint('Before data');
    setState('changed');
    await recovery.restore(record);
    for (const call of commands) {
      assert.equal(call.timeout, { 'mariadb-dump': 600000, mariadb: 900000, aws: 450000 }[call.binary]);
    }
  });
});

test('rollback identity allows the same schema name on different endpoints, never the source endpoint', () => {
  const pair = { dev: { host: 'source', port: 3306, schema: 'app' },
    target: { host: 'target', port: 3307, schema: 'app' } };
  const record = { target: { ...pair.target } };
  assert.doesNotThrow(() => validateIdentity(record, pair));
  assert.throws(() => validateIdentity({ target: { ...pair.dev } },
    { ...pair, target: pair.dev }), /source restoration is forbidden/);
});


test('loopback recovery keeps verified local backups without TLS or S3', async () => {
  await fixture(async ({ open, commands, setState, getState }) => {
    const recovery = await open();
    const checkpoint = await recovery.checkpoint('local stage');
    assert.equal(checkpoint.storage, 'local');
    assert.ok(commands.every(command => command.binary !== 'aws'));
    setState('changed local target');
    await recovery.restore(checkpoint);
    assert.equal(getState(), 'initial target schema, records and Atlas history');
  }, { local: true });
});
