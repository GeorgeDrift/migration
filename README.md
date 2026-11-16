# Fabla RDS migration tool

RDS performance comparison instructions and deterministic disposable fixtures are
in [BENCHMARK.md](BENCHMARK.md). The workflow reports phase timings; offline tests
do not establish RDS speed. See [RECOVERY.md](RECOVERY.md) for mandatory backups,
crash-safe undo journaling and durable pre-migration schema evidence.

Use the schema-first CLI for migration_dev to migration_target (or two
explicitly configured, different Fabla schemas). It previews by default.
The legacy-v1 HTTP endpoint is a separate transformation and is not used here.

Simple commands load `.env.localdb` when it exists and otherwise use deployed
environment variables:

```powershell
npm.cmd run migration:compare
npm.cmd run migrate
npm.cmd run migration:rollback
```

For the confirmed CloudShell test pair, use the one-command guided launcher in
[CLOUDSHELL-EASY.md](CLOUDSHELL-EASY.md). It handles setup, credentials, S3 checks,
saved checkpoint downloads, comparison and the confirmed interactive menu.

## Setup

Run `npm ci` in this directory. Set:

    MIGRATION_DB_HOST
    MIGRATION_DB_PORT
    DEV_DB_HOST
    DEV_DB_PORT
    TARGET_DB_HOST
    TARGET_DB_PORT
    MIGRATION_SOURCE_DB
    MIGRATION_TARGET_DB
    DEV_DB_USER
    DEV_DB_PASSWORD
    TARGET_DB_USER
    TARGET_DB_PASSWORD
    RDS_CA_BUNDLE

`MIGRATION_DB_PASSWORD` and `MIGRATION_DB_USER` are shared fallbacks.
`DEV_DB_HOST`/`DEV_DB_PORT` and `TARGET_DB_HOST`/`TARGET_DB_PORT` override the
shared host and port independently. Without overrides the existing single-RDS
test configuration is unchanged. Different instances may use the same database
name; the exact same configured host, port and database cannot be both source
and target. Use canonical endpoints, not different aliases for the same server.
The guided CloudShell launcher remains deliberately pinned to the confirmed
single-instance dev/test pair; use the standard CLI for other approved endpoints.
Connections require verified TLS. Use a read-only source account where
possible. Do not commit credentials or saved previews containing procedure
definitions. The design and release gates are in MIGRATION_PLAN.md.

For this workstation, `.env.local` is git-ignored and already contains the
non-secret RDS host, port, and source/target schema names taken from the
DBeaver connection. Add the database username/password and the path to a
trusted RDS CA bundle there yourself; do not paste passwords in chat.
Then use `npm run migration:local -- <choice>` or
`npm run schema:diff:local`. The standard scripts still accept exported
environment variables.

## Nine choices

From this directory, preview one of the following (or use the local npm
script after filling `.env.local`):

    node tool.mjs schema
    node tool.mjs all-data
    node tool.mjs stored-procedures
    node tool.mjs one-experiment --experiment-id 123
    node tool.mjs one-experiment-with-procedures --experiment-id 123
    node tool.mjs all
    node tool.mjs experiment-only --experiment-id 123
    node tool.mjs experiment-only --experiment-id 123 --experiment-id 456
    node tool.mjs experiment-only --login-code CODE_A --login-code CODE_B
    node tool.mjs experiment-only --all-experiments
    node tool.mjs procedures-only
    node tool.mjs records-only

The first six choices and experiment-only compare schemas and apply reviewed
schema changes before their selected content stage. Procedures-only and
records-only compare schemas but never apply schema changes; they require
matching schemas with no pending reviewed SQL or history errors. Records-only
copies all application records without procedures. Procedures-only copies
approved procedures without application records. In the menu these are options
9 and 8 respectively; option 10 exits.
`experiment-only` accepts any selected number of experiment IDs or researcher
login codes (you may mix them), or `--all-experiments`. Login codes are resolved
against the source and duplicates are copied once. The preview lists the
resolved IDs and per-table counts. Prefer IDs where possible: login codes in
command arguments can be retained in shell history and process listings.
Only experiment-related records are copied, not unrelated tables or stored
procedures. All selected inserts use one target transaction, so a failed copy
rolls them all back. Large selections can be expensive; review the preview
before execution.
`--with-procedures` remains an alias for the combined record choices.
If schema SQL is pending, a schema-inclusive preview prints it and defers
content. Confirmed execution prepares schema, verifies it, then previews and
copies the selected content. Standalone options stop on pending SQL or drift
instead of preparing schema. The interactive menu can register new schema SQL
only after explicit approval for a schema-inclusive option.

The all-data choice inventories every application base table (excluding Atlas
revisions), compares complete table metadata, and copies missing rows in
foreign-key order. Identical rows are skipped; differing rows stop the run.
It keeps foreign-key checks enabled and verifies content and counts before
each table transaction commits. Already committed tables are named if a later
table fails.

All-record and experiment copies retain JSON as its original document text and
use prepared inserts rather than SQL text formatting. This preserves JSON
arrays, scalar strings, large numeric literals and escaping without double
encoding. Comparison uses the same raw representation. Invalid source values
or target constraint failures still stop the run; checks are never disabled.
Both copiers use `dateStrings: true`, and copying/comparison sessions use UTC
for TIMESTAMP values. DATETIME wall times, zero dates and fractional seconds
remain strings instead of being reinterpreted through JavaScript Date objects.
Schema comparison includes foreign-key update/delete/match rules and CHECK
expressions. A catalog permission/version failure is not treated as equality.

The one-experiment choice previews table-by-table counts for the selected
experiment, studies, diaries, time windows, onboarding questions, variable
labels, notifications, question banks and mappings, participants, and legacy
question/notification tables and participant diary versions when present.
Both the legacy 12-table schema and the known modern optional tables are
supported. Unknown foreign-key dependents still block execution rather than
being silently omitted. Relationships not declared as foreign keys need an
explicit reviewed mapping before support is extended to another application.
Shared external parents such as teams must match by complete row contents,
not merely by ID; they are not implicitly copied or overwritten.
It rejects missing parents,
cross-experiment references, foreign-key cycles, and conflicting target IDs
or unique values. Its inserts and verification use one target transaction.
The source and target must have matching definitions for those tables.

The procedure choice previews names, SQL, SHA-256 hashes, and excluded
functions/triggers/views/events. The interactive menu resolves the actual
authenticated target account using `CURRENT_USER()` and displays it before
asking `Copy these ... stored procedures using this target account? [y/N]:`.
It reuses the existing target connection password; no separate procedure
password or mandatory definer environment configuration is needed. Answering
yes approves the displayed exact SQL, creation SQL mode, account and endpoint
identity in `procedure-policy.json`, after rechecking the live definitions.
The target account becomes the procedure definer; routines retain their
original SQL SECURITY behavior. DEFINER routines use that account's permissions.
Using an admin connection therefore requires accepting admin-level procedure
permissions. Prefer a least-privilege target connection in production.
Optional `MIGRATION_PROCEDURE_DEFINER_USER` and `MIGRATION_PROCEDURE_DEFINER_HOST`
overrides remain supported; set both or neither. No users or grants are created.
Declining procedures in a combined choice keeps only its schema/record scope,
displayed for a separate final confirmation. Declining procedures-only cancels.

Execution will not create an unapproved procedure. Old approvals missing the
endpoint identity must be reviewed again using the interactive menu. CLI-only
runs require those saved approvals; direct commands never silently approve SQL.
Creating a procedure for a different definer may need
additional MariaDB/RDS privileges; no accounts or grants are created by this tool.
The source creation SQL mode is preserved and the operator session mode restored.
Existing procedures must match the approved definer, SQL and mode or copying stops.
Schema-inclusive executions check procedure configuration, definitions and approvals
before applying pending schema changes. Missing procedure configuration therefore
stops before schema or record writes, without requiring a restore of those changes.
Procedure previews are repeated after schema preparation to catch intervening changes.
Procedure DDL is not transactional; the CLI
reports names completed before a failure, and a fresh preview can skip
identical definitions.

## Reviewed schema SQL

`npm run schema:diff` is read-only review material. Add real, versioned Fabla
SQL files under `migrations/`, record each SHA-256 and risk in
`migration-policy.json`, and regenerate the Atlas directory checksum. The
demo SQL under `examples/` is not a production baseline. This repository
currently contains no reviewed production migration, so an empty target
cannot be initialized until that baseline is reviewed and added.

## Execution gate

For an empty disposable target, the interactive menu can append an exact
numeric correction to replay historical CREATE TABLE files without changing
their approved bytes. The whole replay chain is validated, only empty targets
are eligible, and final schema equality is required before any content copying.
See INTERACTIVE.md for reset and reviewed-file preservation requirements.

Only after reviewing the preview, add:

    --execute --confirm-target <exact-target-schema> --confirm-host <exact-target-host>

Destructive reviewed schema SQL additionally requires `--allow-destructive`.
A partial Atlas revision requires manual inspection before `--resume-partial`.
Never treat an interrupted schema or procedure stage as rolled back. Use a
fresh preview to determine what remains. Do not use this tool to transform
legacy v1 records into the newer data model.

## Validation

`npm run check` runs local syntax, migration-policy, demo-provider, and unit
checks without connecting to RDS. Live schema and data verification still
requires credentials and a selected experiment ID. Do a read-only RDS preview
and review the output before considering any write to an empty target.

The CI workflow now runs `npm run check:integration` against a disposable
MariaDB 10.11 service after the offline tests on migration-related pushes
(including a branch without a PR), pull requests and manual dispatch.
Only manual dispatch can request the separate read-only RDS preview job.
The read-only RDS preview job
depends on this integration job. Make the integration check required in the
repository's branch protection/ruleset before a production release; local CLI
execution is not made safe just by adding a workflow. Test the exact production
MariaDB version and real backup/restore procedure before approving production use.

The integration harness uses only `INTEGRATION_MARIADB_*` settings, requires an
explicit loopback host and password, and creates/drops randomly named test
databases and a restricted routine account. It must run on an isolated test
server, never RDS. It exercises the real baseline and numeric repair, FK/CHECK
drift, both experiment variants, shared parents, prepared record copies,
date/JSON/binary fidelity, idempotency, conflicts, transaction rollback and
procedure approval/creation. It does not certify S3 recovery or Atlas execution;
these still need a separate disposable end-to-end test. No AWS secrets are
available to the integration job.

## How Migration Works

The normal workflow validates reviewed SQL files, policy checksums and Atlas
revision history before applying pending migrations. Live differences without
pending reviewed SQL stop deployment. Generate proposals with `npm run schema:diff`,
review and register forward and optional reverse SQL in the migration policy,
and regenerate the Atlas directory checksum before deployment.

Preview approval is bound to the files, reverse SQL, target and pending history
using `--expect-change`. Destructive migrations require `--allow-destructive` and
a single pending migration. The interactive menu requests this approval explicitly.
The workflow takes a verified checkpoint, revalidates the plan under the recovery
lock and applies files through the versioned Atlas runner. Each file receives
pre-migration schema evidence; content remains blocked until schema verification.

`rollback.mjs down` uses reviewed reverse SQL and statement progress recorded in
Atlas revisions when versioned history exists. Destructive undo additionally
requires `--allow-destructive`. Uncertain statement outcomes require inspection
or checkpoint restoration. Legacy deployments retain their previous undo path.
Full checkpoint restore replaces records as well as schema. Missing-only schema
filtering is not implemented; reviewed SQL must express the intended additions.
See RECOVERY.md for maintenance and backup prerequisites.

## Backup Timeouts

Logical target backups and S3 recovery remain mandatory before writes.
Timeouts are independently configurable in milliseconds (default 300000,
allowed range 1 through 86400000):

    MIGRATION_DUMP_TIMEOUT_MS=1800000
    MIGRATION_RESTORE_TIMEOUT_MS=3600000
    MIGRATION_S3_TIMEOUT_MS=900000

Timeout/failure never implies a successful backup or restore. The target must
remain in maintenance throughout copying and recovery. Larger databases need
measured dump/restore durations, sufficient local disk and tested recovery;
increasing a timeout alone does not guarantee recoverability. This change does
not create RDS snapshots or make CloudShell storage persistent. Instance-level
RDS snapshot restoration is a separate DBA-managed workflow and affects both
databases when source and target share an instance.


## Local XAMPP migration

The git-ignored `migration/.env.xampp` selects `intern` as source and
`migration_target` as target on `127.0.0.1:3306`. From `migration/`, preview
with `node --env-file=.env.xampp tool.mjs all-data`. Local-only mode permits
an empty password, disables TLS and S3 only when both endpoints are loopback,
and retains target dumps and rollback records in the configured recovery directory.
Keep these local backups: they have no remote copy. Atlas revision history is
excluded from application copying. Use the interactive menu to review procedures.

To choose a previous saved state interactively in PowerShell, run
`node --env-file=.env.xampp rollback.mjs menu`. Choices are named
?Before stored procedures?, ?Before records?, and ?Before schema changes?
when those backups exist. Review the timestamp, select a number, then confirm
the full target restore.
