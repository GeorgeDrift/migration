# Read-only database comparison

Run `npm run compare` in CloudShell after setting the existing database passwords
and RDS_CA_BUNDLE. On the desktop, `npm run compare:local` also loads .env.local.
Neither command accepts --execute. They do not copy records or apply migrations.

The default display is a side-by-side Source/Target report: total table and record
counts, stored procedure counts, per-table record counts and row differences,
followed by schema field differences and procedure presence/definition status.
Use `npm run compare -- --json` for the full structured report instead.
Unavailable totals are marked partial; a dash is not a zero count. Table counts
exclude Atlas revision metadata. Functions, triggers, views and events are counted
as inventory only, not verified for matching definitions.

The report includes exact schema metadata differences, source and target row
counts, missing target rows, extra target rows, changed matching rows, identical
rows, and changed column names. It does not print record values or passwords.
Procedures are compared without printing their bodies; definers are normalized.
Functions, triggers, views and events are listed but their definitions are not
compared. Atlas revision records are excluded from application table comparison.

An incompatible or missing table is marked skipped, with available row counts.
A failed table query is marked unavailable. The remaining tables are inspected.
`complete: false` means some selected tables or procedures could not be fully
compared; a successful command is not proof that the databases match.
Differences are report results, not write authorization.

Data comparison requires identical table metadata, an InnoDB engine and a usable
full-column primary/unique identity key. It uses batched SELECTs inside separate
read-only repeatable-read transactions. Pause application writes and schema
changes for a meaningful point-in-time comparison: the two snapshots start at
different moments and do not provide a global cross-database snapshot.
Large tables can take time; OFFSET pagination trades performance for portability.

`node copy-data.mjs` without --execute now uses this non-aborting table comparison
(without procedure comparison). Its --execute path retains all existing strict
schema and row conflict checks. No schema mismatch is silently ignored or fixed.
`node tool.mjs schema` now includes differenceDetails to diagnose the study
metadata mismatch before any corrective schema migration is approved.

These changes do not implement backup/restore, and cannot undo earlier migrations.
