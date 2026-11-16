import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('.', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

// Revisions whose reverse SQL stopped partway carry this prefix in Atlas's error column.
export const DOWN_MARKER = 'fabla-down:';

export function downDirectory(root = defaultRoot) {
  return join(root, 'down-migrations');
}

function downFiles(root) {
  const directory = downDirectory(root);
  return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.sql')).sort() : [];
}

export function loadMigrations({ root = defaultRoot } = {}) {
  const policy = JSON.parse(readFileSync(join(root, 'migration-policy.json'), 'utf8'));
  const names = readdirSync(join(root, 'migrations')).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  if (names.length !== Object.keys(policy).length) {
    throw new Error('Migration files and reviewed migration policy differ. Review and lock every migration before running.');
  }
  const reverse = new Set(downFiles(root));
  for (const name of reverse) {
    if (!policy[name]?.down) throw new Error(`Reverse SQL ${name} is unreviewed or has no forward migration; stop before connecting to RDS.`);
  }
  return names.map(name => {
    const entry = policy[name];
    const hash = sha256(readFileSync(join(root, 'migrations', name)));
    if (!entry || entry.sha256 !== hash || entry.scope !== 'schema' || !['additive', 'destructive'].includes(entry.risk)) {
      throw new Error(`Migration ${name} is unreviewed or changed; stop before connecting to RDS.`);
    }
    let down;
    if (entry.down) {
      if (!reverse.has(name) || entry.down.sha256 !== sha256(readFileSync(join(downDirectory(root), name)))
          || !['additive', 'destructive'].includes(entry.down.risk)) {
        throw new Error(`Reverse SQL for ${name} is missing, unreviewed or changed; stop before connecting to RDS.`);
      }
      down = { sha256: entry.down.sha256, risk: entry.down.risk };
    }
    return { name, version: name.split('_', 1)[0], risk: entry.risk, ...(down ? { down } : {}) };
  });
}

export function readDownSql(migration, { root = defaultRoot } = {}) {
  if (!migration.down) throw new Error(`Migration ${migration.name} has no reviewed reverse SQL.`);
  const sql = readFileSync(join(downDirectory(root), migration.name), 'utf8');
  if (sha256(sql) !== migration.down.sha256) throw new Error(`Reverse SQL for ${migration.name} changed after review.`);
  return sql;
}

export function pendingMigrations(migrations, revisions) {
  const known = new Set(migrations.map(migration => migration.version));
  const byVersion = new Map();
  for (const revision of revisions) {
    const version = String(revision.version);
    if (!known.has(version) || byVersion.has(version)) {
      throw new Error(`Atlas revision history contains an unknown or duplicate version: ${version}`);
    }
    if (String(revision.error || '').startsWith(DOWN_MARKER)) {
      throw new Error(`Schema undo of migration ${version} stopped partway. Run "npm run rollback -- down" to finish it, or restore a saved checkpoint.`);
    }
    byVersion.set(version, revision);
  }

  let pendingSeen = false;
  const pending = [];
  for (const migration of migrations) {
    const revision = byVersion.get(migration.version);
    const complete = revision && Number(revision.applied) === Number(revision.total) && !revision.error;
    if (complete && pendingSeen) {
      throw new Error('Atlas revision history is out of order; inspect it before applying changes.');
    }
    if (!complete) {
      pendingSeen = true;
      pending.push({ ...migration, partial: Boolean(revision) });
    }
  }
  return pending;
}

export function assertAllowedSelection(selected, { action, allowDestructive, resumePartial = false, execute = false }) {
  if (execute && selected.some(migration => migration.partial) && !resumePartial) {
    throw new Error('A migration is partially recorded. Inspect Atlas status and the actual schema, then pass --resume-partial only after confirming the recorded statement position.');
  }
  if (selected.some(migration => migration.risk === 'destructive')) {
    if (!allowDestructive || selected.length !== 1) {
      throw new Error('A destructive migration requires --allow-destructive and a single-migration run.');
    }
  }
}
