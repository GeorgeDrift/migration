# Recovered Migration History

The test target records version 202610020001, but the original SQL and approval
policy were created only in a temporary CloudShell session. After that session
reset, GitHub contained no SQL migrations, so the fresh clone correctly refused
the unknown recorded version.

The original 202610020001_create_target_tables.sql was recovered from the user's
earlier structured preview. The recovered bytes match the originally approved
SHA-256 exactly:

```text
4362dd3c29d1cef70fe238d0fbda3999bb7de42eaf17b17caf28ff5f84bf0939
```

The original schema/additive policy entry is restored, not newly approved for
different SQL. The Atlas directory checksum was reconstructed using its published
filename/content checksum format:
https://github.com/ariga/atlas/blob/master/sql/migrate/dir.go

This is restoration of local history files only. No RDS connection, history
reset, table deletion or database write was performed.

## Publish And Verify

Publish the restored SQL, migration-policy.json, migrations/atlas.sum and the
line-ending rules to the branch before pulling in CloudShell. Keep historical
SQL in Git so a session reset cannot lose it again.

In CloudShell, after publishing:

```bash
cd ~/fabla-migration/migration
git pull --ff-only origin 'migratio_rds_sequeliser+atlas'
node verify-migrations.mjs
atlas migrate validate --dir file://migrations
timeout 120s node tool.mjs schema
```

These are read-only database operations or local validation. The expected known
version can now be matched against the SQL files. A duplicate, partial or other
unknown recorded version still needs inspection; it is never silently removed.

## Do Not Rewrite Or Reapply The Baseline

The original baseline contains the historical plain DOUBLE definitions in study.
They must remain unchanged because that is what was applied. Restore the history,
then use a NEW reviewed reconciliation migration to preserve DOUBLE(10,2).
Code changes alone do not alter the existing study table.

An empty target would make the old baseline pending again. The numeric fidelity
guard deliberately blocks replaying its lossy definitions. This recovered
baseline is historical, not a newly corrected fresh-install migration.

The separate mandatory recovery configuration still applies before database
writes. Restoring history does not bypass backups or configure S3.

