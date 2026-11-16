import { readFileSync } from 'node:fs';

const defaultHost = 'george-migration-dev.c1keeq28q8mb.us-east-1.rds.amazonaws.com';
const loopbackHosts = ['127.0.0.1', '::1', 'localhost'];

export function isLoopback(host) {
  return loopbackHosts.includes(String(host).toLowerCase());
}

export function databaseConfigs(env = process.env) {
  const host = env.MIGRATION_DB_HOST || defaultHost;
  const devUser = env.DEV_DB_USER || env.MIGRATION_DB_USER || 'admin';
  const sourceSchema = env.MIGRATION_SOURCE_DB || 'migration_dev';
  const targetSchema = env.MIGRATION_TARGET_DB || 'migration_target';
  const port = Number(env.MIGRATION_DB_PORT || env.DB_PORT || 3306);
  const sourceHost = env.DEV_DB_HOST || host;
  const targetHost = env.TARGET_DB_HOST || host;
  const sourcePort = Number(env.DEV_DB_PORT || port);
  const targetPort = Number(env.TARGET_DB_PORT || port);
  if (![sourceSchema, targetSchema].every(name => /^[A-Za-z0-9_-]+$/.test(name))) {
    throw new Error('Migration database names may contain only letters, numbers, underscores, and hyphens.');
  }
  if (sourceSchema === targetSchema && sourceHost.toLowerCase() === targetHost.toLowerCase()
    && sourcePort === targetPort) {
    throw new Error('Source and target databases must be different.');
  }
  if (![sourcePort, targetPort].every(value => Number.isInteger(value) && value >= 1 && value <= 65535)) {
    throw new Error('Migration database port must be an integer from 1 to 65535.');
  }
  if (env.MIGRATION_LOCAL_ONLY === '1' && !(isLoopback(sourceHost) && isLoopback(targetHost))) {
    throw new Error('MIGRATION_LOCAL_ONLY=1 requires loopback source and target hosts (127.0.0.1, ::1 or localhost).');
  }
  return {
    dev: { host: sourceHost, port: sourcePort, schema: sourceSchema, user: devUser, passwordKey: 'DEV_DB_PASSWORD' },
    target: {
      host: targetHost, port: targetPort, schema: targetSchema, user: env.TARGET_DB_USER || env.MIGRATION_DB_USER || devUser,
      passwordKey: 'TARGET_DB_PASSWORD',
    },
  };
}

export function passwordFor(config, env = process.env) {
  if (localOnly(env)) return env[config.passwordKey] ?? env.MIGRATION_DB_PASSWORD ?? '';
  return env[config.passwordKey] || env.MIGRATION_DB_PASSWORD || undefined;
}

// A disposable workstation server: no TLS and no S3. Only honoured when both hosts are loopback.
export function localOnly(env = process.env) {
  if (env.MIGRATION_LOCAL_ONLY !== '1') return false;
  databaseConfigs(env);
  return true;
}

// The CA used to verify TLS, or null for a local-only run.
export function readCa(env = process.env) {
  if (localOnly(env)) return null;
  if (!env.RDS_CA_BUNDLE) throw new Error('Set RDS_CA_BUNDLE. Verified TLS is required except for MIGRATION_LOCAL_ONLY=1 loopback runs.');
  return readFileSync(env.RDS_CA_BUNDLE);
}

// mysql2 `ssl` option. Without a CA only a loopback host may connect, and then without TLS.
export function sslFor(config, ca) {
  if (ca) return { ca, rejectUnauthorized: true };
  if (isLoopback(config.host)) return undefined;
  throw new Error(`Verified TLS is required for ${config.host}; set RDS_CA_BUNDLE.`);
}



