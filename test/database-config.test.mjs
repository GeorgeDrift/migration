import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConfigs, passwordFor, readCa } from '../database-config.mjs';

test('source and target use separate schemas on the existing RDS instance', () => {
  const { dev, target } = databaseConfigs({});
  assert.equal(dev.host, 'george-migration-dev.c1keeq28q8mb.us-east-1.rds.amazonaws.com');
  assert.equal(target.host, dev.host);
  assert.equal(dev.schema, 'migration_dev');
  assert.equal(target.schema, 'migration_target');
  assert.equal(dev.user, 'admin');
  assert.equal(target.user, 'admin');
});

test('an explicit host or target user is shared only as intended', () => {
  const { dev, target } = databaseConfigs({
    MIGRATION_DB_HOST: 'example.rds.amazonaws.com',
    DEV_DB_USER: 'source_user', TARGET_DB_USER: 'target_user',
  });
  assert.equal(dev.host, 'example.rds.amazonaws.com');
  assert.equal(target.host, dev.host);
  assert.equal(dev.user, 'source_user');
  assert.equal(target.user, 'target_user');
});

test('each endpoint can override the shared host and port independently', () => {
  const result = databaseConfigs({ MIGRATION_DB_HOST: 'fallback', MIGRATION_DB_PORT: '3307',
    DEV_DB_HOST: 'source', DEV_DB_PORT: '3308', TARGET_DB_HOST: 'target', TARGET_DB_PORT: '3309',
    MIGRATION_SOURCE_DB: 'app', MIGRATION_TARGET_DB: 'app' });
  assert.equal(result.dev.host, 'source');
  assert.equal(result.target.host, 'target');
  assert.equal(result.dev.port, 3308);
  assert.equal(result.target.port, 3309);
  assert.equal(databaseConfigs({ DEV_DB_PORT: '3308' }).target.port, 3306);
  for (const port of ['0', '65536', '3306abc', '1.5']) {
    assert.throws(() => databaseConfigs({ TARGET_DB_PORT: port }), /port must/);
  }
  assert.throws(() => databaseConfigs({ MIGRATION_SOURCE_DB: 'same', MIGRATION_TARGET_DB: 'same',
    DEV_DB_HOST: 'HOST', TARGET_DB_HOST: 'host' }), /must be different/);
});


test('empty passwords are accepted only in explicit loopback local mode', () => {
  const env = { MIGRATION_LOCAL_ONLY: '1', MIGRATION_DB_HOST: '127.0.0.1', MIGRATION_DB_PASSWORD: '' };
  assert.equal(passwordFor(databaseConfigs(env).target, env), '');
  assert.equal(readCa(env), null);
  assert.equal(passwordFor(databaseConfigs({}).target, { MIGRATION_DB_PASSWORD: '' }), undefined);
  assert.throws(() => passwordFor(databaseConfigs({}).target, { ...env, MIGRATION_DB_HOST: 'remote' }), /loopback/);
});
