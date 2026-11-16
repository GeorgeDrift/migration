# Migration Recovery

Recovery protects the configured target database only, not the entire RDS
instance. It never restores the source. This is not a failure-proof system.
Local tests use mock clients; a restore drill on a disposable test database is
required before production use.

## Before Any Write

An administrator must provide an approved private S3 bucket and prefix. No bucket
is created by this tool. Its AWS identity needs PutObject and GetObject for that
prefix, plus ListBucket for downloading saved checkpoints with s3 sync.
Use bucket access restrictions, encryption and preferably versioning. A KMS key
also requires the appropriate KMS permissions. Backups contain complete database
records and potentially sensitive information; never commit them to GitHub.

The machine must have AWS CLI, mariadb-dump and mariadb installed. Check:

```bash
aws --version
mariadb-dump --version
mariadb --version
```

The shared client options must not include `connect-timeout`: the CloudShell
MariaDB 10.5 dump client rejects it, including when read from an option file.
External backup and restore commands still have a five-minute process deadline;
the recovery lock connection uses a separate fifteen-second connection timeout.

Configure the normal source/target settings, database passwords and RDS_CA_BUNDLE.
Then configure recovery, replacing the bucket placeholder with an approved value:

```bash
export MIGRATION_RECOVERY_DIR="$HOME/migration-target-checkpoints"
export MIGRATION_RECOVERY_S3_URI='s3://YOUR-APPROVED-PRIVATE-BUCKET/george-migration/migration_target'
```

Stop applications, scheduled jobs and people writing to the target before
migration or restore. Only after doing so acknowledge maintenance:

```bash
export MIGRATION_MAINTENANCE_TARGET='migration_target'
npm run migration:interactive
```

The acknowledgement does not stop external writers. The named database lock
serializes this tool's operations; other applications must cooperate.
Recovery also requires privileges to dump the complete target, inspect its
metadata and restore it, including dropping/recreating the target database.
It refuses non-InnoDB tables, unsupported table types, scheduled events and
cross-database foreign keys. Missing tools, permissions or verified durable
storage block writes. Use a target-specific recovery directory and S3 prefix.

## Checkpoints And Automatic Recovery

Before each reviewed schema migration and each selected content stage, the tool:

1. Dumps the complete target, including tables, records, views, triggers,
   routines and Atlas database revision history.
2. Uploads the SQL and manifest to encrypted S3 storage.
3. Downloads and verifies their checksums before allowing the write.

A caught failure or schema mismatch after writes triggers an attempt to restore
the first checkpoint of that workflow, undoing the entire attempted workflow.
Before restoration it saves the current state as a separate rescue checkpoint.
It then dumps the restored target and checks its fingerprint against the original.
Only a matching fingerprint is reported as verified. A failed or interrupted
restore may leave a partial target: preserve both original and rescue backups,
stop writers and investigate before retrying. Process termination, unavailable
RDS or lost connectivity can prevent automatic restoration.

The failure menu can offer the three latest saved stage checkpoints. Labels and
timestamps identify the states. They are not SQL-statement undo steps, and after
a previous restore they are not necessarily three changes behind the current
state. A checkpoint must already exist; changes made before this system saved
backups cannot be recovered retrospectively. All checkpoints are retained;
coordinate S3 lifecycle and costs without deleting required recovery history.

## Schema Changes And Undo

Migration compares the live schemas and validates reviewed migration files and
Atlas history. Drift without pending reviewed SQL is refused. Preview lists the
approved SQL and binds execution to its contents, target and revision state.
Execution saves a checkpoint and applies versioned SQL through Atlas. Caught
failures trigger a checkpoint restore attempt; a failed restore requires manual
recovery. Destructive migrations require `--allow-destructive`.

Additional deployment evidence is recorded in
`MIGRATION_RECOVERY_DIR/schema-changes/` and in S3 under `schema-changes/`:
the SQL that ran, its reverse SQL, the target schema before and after, and the
checkpoint taken before it. Versioned undo uses the reviewed reverse files,
Atlas revisions and pre-migration schema snapshots. External evidence is optional;
legacy live-diff deployments continue to use their recorded reverse SQL.

```bash
npm run rollback -- down                 # preview undoing the last schema change
npm run rollback -- down --steps 2       # preview undoing the last two, newest first
npm run rollback -- down --allow-destructive --execute --confirm-target migration_target --confirm-host george-migration-dev.c1keeq28q8mb.us-east-1.rds.amazonaws.com
```

In the menu, choose `R`, then `1`, then answer `Apply? [y/N]`.

- Legacy undo refuses drift after its recorded change. Versioned undo requires
  reviewed reverse SQL and pre-migration evidence; uncertain statement outcomes
  block replay and require inspection or checkpoint restoration.
- Undo always saves a checkpoint first, checks each step against the recorded
  "schema before", and restores that checkpoint automatically if anything fails.
- Undo restores schema only. Data in columns or tables dropped by the reverse
  SQL is lost; restore a checkpoint when data must come back.
- A change without reverse SQL is undone by restoring the checkpoint named in
  its record.

## Choose A Saved State

Listing and restore previews do not modify the database:

```bash
npm run rollback -- list
npm run rollback -- restore --steps 1
npm run rollback -- restore --steps 2
npm run rollback -- restore --steps 3
```

Execution requires explicit target confirmation. This example restores the most
recent saved stage state and replaces ALL current contents of migration_target:

```bash
npm run rollback -- restore --steps 1 --execute --confirm-target migration_target --confirm-host george-migration-dev.c1keeq28q8mb.us-east-1.rds.amazonaws.com
```

Use --steps 2 or --steps 3 for the other available states. The host, port and
database must match the checkpoint exactly. The source remains untouched.
RDS configuration, IAM, users/grants and other databases are not restored.
Restoring Atlas history means newer versioned SQL can become pending again;
never edit already-applied migration files to force a match.

## After Temporary CloudShell Resets

CloudShell VPC environments lose local files when the environment ends. Recreate
the clone and tools, configure credentials and the same recovery settings, then
download the durable checkpoints outside the repository:

```bash
aws s3 sync "$MIGRATION_RECOVERY_S3_URI/" "$MIGRATION_RECOVERY_DIR/" --only-show-errors
npm run rollback -- list
```

Restrict local backup-directory access. Local checkpoint files and temporary
client credential files use owner-only permissions on Linux. Windows ACL safety
is not validated by these tests. SQL credentials are not passed in command-line
arguments, and temporary credential files are removed when cleanup completes.

## Remaining Validation

First rehearse a successful migration and restoration on a disposable target,
including stored routines, views, foreign keys and Atlas history. Check data and
schema after restoration, client/server version compatibility, dump privileges,
S3 permissions and network access. No live AWS migration or restore has been
performed as part of this code change. Exact dump fingerprints fail closed if a
client emits non-deterministic output; investigate rather than ignoring the check.
