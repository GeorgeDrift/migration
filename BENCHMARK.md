# RDS comparison and reversal benchmark

This kit prepares identical inputs and validates measurements. It has NOT been
run against RDS or the supervisor's implementation. No winner is known. The other
implementation's command adapter and a real approved RDS run are still required.
Offline test durations are not migration performance results.

## Prepare identical fixtures without connecting to AWS

In CloudShell Bash, inside the migration directory:

```bash
npm run benchmark:fixture -- "$HOME/fabla-benchmark-fixture" 1000
```

Use a new output directory each time. This only writes SQL and a manifest. It
does not create databases or execute a migration. The fixture has seven related
tables, seven foreign keys, unique indexes, 1,000 records per table and changes
to all seven tables. `change.sql` and `reverse.sql` are inverses for the fixture.
Increase the last argument for larger tests, up to 100,000 records per table.

## Approved live test procedure

1. Obtain approval for disposable schemas named `fabla_bench_<run>_<implementation>`.
   Never use `migration_dev`, `migration_target` or production as benchmark targets.
   Use the same RDS instance, client machine, engine version, region/network route,
   row counts and security settings for both implementations. Keep all target
   writers paused. Use verified TLS and separate test credentials.
2. Review the generated SQL. Create a separate disposable source and fresh target
   for EACH implementation and repetition. Load the baseline and seed into the
   source and target, so DDL is tested against existing relational data, not only
   empty tables. Run at least three repetitions per implementation, alternating
   their order. Exclude fixture provisioning from migration timings.
3. Capture each target's pre-change schema AND content fingerprint with
   `benchmarkDatabaseDigest(db, schema)` from `benchmark-digest.mjs`. Connections
   must preserve original JSON, exact FLOAT reads, dates, binary and big integers.
   Every table has an ordered identity; the fingerprint is not just a row count.
4. Change the disposable source using the reviewed `change.sql`, then load
   `delta-seed.sql` into the source ONLY. It adds a disjoint range of IDs in every
   table, so the record phase has actual work. Both systems must receive exactly
   the same source contents. Capture its expected digest. The manifest records
   initial, additional and expected total row counts.
5. Register the reviewed fixture SQL/up/down/hash policy in an isolated migration
   checkout, not the Fabla production journal. Use the normal complete workflow,
   including preview, required checkpoint, schema, selected records and verification.
   Do not replace it with a bare SQL loop and label that as the migration system.
6. Record wall-clock milliseconds for comparison, backup, schema, records,
   verification and reversal, plus a separate end-to-end duration. The workflow
   now emits `timingsMs`. Child schema/records timings include their own preflight
   and content checks; final schema verification is separate. Do not sum overlapping
   measurements or exclude safety overhead from just one implementation.
7. Verify zero schema and record differences and the expected complete digest.
   Exercise full checkpoint restore to prove recovery of schema AND records.
   Also test reviewed schema undo separately: it keeps retained values but cannot
   recreate dropped records. A destructive undo must keep its verified backup.
   Measure reversal including required safety work, not only raw inverse SQL.
8. Verify the restored target digest equals its pre-migration digest. Inject a
   failure on a disposable target and repeat verification. A committed DDL with
   a lost acknowledgement must block blind retry; use the verified checkpoint.
   Retain failed-run logs separately, never label a failed run as a fast success.

Creating independent RDS instances is not required; separate disposable schemas
on the approved existing instance are sufficient. Instance and S3 costs still
apply. Do not run both candidates concurrently or relax RDS ingress for this test.

## Record and compare actual results

Each implementation supplies a JSON array of measured samples with these fields:

```text
implementation, runId, revision, fixtureSha256, host, port, runner,
instanceClass, engineVersion, target, tables, changedTables, totalRows,
maintenance: true, backupVerified: true,
schemaDifferences: 0, recordDifferences: 0, reversalDifferences: 0,
beforeDigest, restoredDigest, expectedDigest, afterDigest,
endToEndMs,
timingsMs: { comparison, backup, schema, records, verification, reversal }
```

Use manifest `fixtureSha256` and actual database digests, not invented values.
`restoredDigest` must equal `beforeDigest`; `afterDigest` must equal the expected
source digest. The adapter must capture observations and successful comparisons;
the report validator cannot independently attest to a live database.

```bash
npm run benchmark:report -- "$HOME/ours-results.json" "$HOME/other-results.json"
```

The report refuses incomplete, incorrect, mismatched, duplicate or insufficient
samples. It reports per-phase medians, median end-to-end duration and raw sample
timings. It does not automatically declare production readiness or a universal
speed advantage. Keep records/passwords out of Git and shared videos.

## Current safety/performance changes

- Reverse statements have durable started/completed markers bound to SQL checksums.
- Undo history is revalidated after locking; destructive undo requires verified recovery.
- Schema evidence is encrypted and checksum-verified in S3, and can be fetched after reset.
- Prepared inserts use up to 50 rows by default, capped by bytes and parameter count.
- External-parent content lookups are cached only within one experiment preview.
- Real MariaDB CI exercises all seven seeded tables, full original row contents and
  a commit-before-disconnect failure. CI and RDS results must be collected separately.

Tune `MIGRATION_INSERT_BATCH_SIZE` (1..500) and `MIGRATION_INSERT_MAX_BYTES`
(1..16777216, default 1048576) conservatively below the server's packet limit.
Bounded prepared statements preserve values and propagate constraint errors;
they never use `INSERT IGNORE`, overwrite conflicts or disable foreign keys.
