import { loadMigrations } from './migration-policy.mjs';

const migrations = loadMigrations();
console.log(`Verified ${migrations.length} reviewed migration files.`);
