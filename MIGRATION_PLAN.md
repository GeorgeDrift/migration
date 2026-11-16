# Fabla RDS migration plan

## Objective

Provide one controlled migration workflow from a selected source database to
a selected target database. The operator chooses how much to migrate. Every
choice compares source and target schemas first. Six choices may bring the
target schema to a reviewed version; the two standalone content choices
require an already compatible target and never apply schema SQL. The
operator may stop after schema, copy all application records, copy stored
procedures, or copy one experiment with all related records and participants.
Every choice has a preview before any target write.

This plan covers databases with the same Fabla data model. The existing HTTP
endpoint in controller/migration.controller.mjs transforms legacy v1 data into
the newer model and remains a separate workflow.

## Operator choices

| Choice | Schema | Application records | Stored procedures |
| --- | --- | --- | --- |
| Schema only | Reviewed changes | None | None |
| Schema and all records | Reviewed changes | Every application table | None |
| Schema and procedures | Reviewed changes | None | All reviewed procedures |
| Schema and one experiment | Reviewed changes | Selected experiment and dependent records | None |
| Schema, one experiment, and procedures | Reviewed changes | Selected experiment and dependent records | All reviewed procedures |
| All | Reviewed changes | Every application table | All reviewed procedures |
| Experiment only | Compatibility check only | Selected experiment and dependent records | None |
| Procedures only | Compatibility check only | None | All reviewed procedures |

Record scope is exactly one of none, all, or experiment; procedures are an
independent selection. A schema comparison always runs before any target write.

If the target is not at the required schema version, the preview must identify
the reviewed migrations required. Execution applies those migrations before
copying anything else, or stops if a required migration is absent. Choosing
records or procedures never authorizes an unreviewed schema difference.

## Record scope

### All records

Copy all application base tables, excluding Atlas revision metadata. Require
compatible source and target definitions for columns, generated expressions,
indexes, unique constraints, foreign keys, defaults, and collation. Existing
identical rows may be skipped; missing rows are inserted; conflicting rows
stop the run. Preview table counts and estimated size. Verify both row counts
and row content after copying, while preserving foreign-key integrity.

### One experiment

Select a source experiment by numeric ID. Preview its identity and a count for
every included table. Copy only rows belonging to that experiment, preserving
IDs and references when the schemas match. The known dependency graph includes:

- experiment, study, diaries, and diary_time_window_map;
- experiment_onboarding_questions and experiment_variable_labels;
- study_notifications;
- notifications and diary_notification_map;
- question_bank and diary_question_map;
- user participants and user_on_question;
- the still-used legacy diary_notifications, questions, and options tables
  when present in both databases.

Inventory every foreign key and application-level reference from those rows
against the actual database schemas. Resolve or reject dependencies outside
the selected experiment, including owner, team, and shared records. Do not
silently omit a related row. Reject target ID and login-code collisions whose
content differs. Use one target transaction for experiment records and verify
the copied graph before commit.

### Stored procedures

Preview procedure names and definitions separately from records. Check
target collisions, referenced tables, SQL security mode, definers, and
source-schema-qualified names. Copy only reviewed definitions with an approved
target definer. Routine DDL cannot be rolled back with the record transaction;
report which procedures completed so a retry can resume safely. Enumerate
functions, triggers, views, and events in the preview, but leave them out of
execution until their scope is decided.

## Execution sequence and gates

1. Identify source and target host, port, schema, and account. Reject equal
   source and target schemas. Require TLS and use a read-only source account
   where possible.
2. Inspect the real schema, Atlas revisions, reviewed SQL, and checksums. An
   empty target needs a reviewed Fabla baseline; the seven-table demo is not
   that baseline.
3. Preview schema statements and destructive risk first. When schema is
   already compatible, preview selected record counts, procedure actions,
   dependencies, collisions, and verification checks. If schema SQL is
   pending, apply and verify it as a separate stage, then require a fresh
   content preview. Preview creates no target tables or rows.
4. Apply only reviewed, versioned schema migrations in order. Stop on a
   missing migration, checksum mismatch, revision drift, or partial revision
   needing manual review.
5. Reinspect the target schema. Start selected records or procedures only
   after compatibility is confirmed.
6. Copy the selected content. Never overwrite a conflicting target row.
7. Report applied versions, copied and skipped counts, mismatches, completed
   procedures, elapsed time, and recovery state. Exclude passwords and
   participant contents from logs.

Schema and procedure DDL cannot be rolled back as one transaction with record
copy. A later failure must not be reported as a complete rollback. Keep a
resumable stage report and require a fresh preview before retrying.

Execution requires --execute and exact target schema and host confirmation.
Experiment scope also requires --experiment-id. An omitted ID must never imply
all records.

## Implementation plan

1. Inspect the intended source and target schemas. Review the schema diff;
   add real Fabla production SQL migrations, policy hashes, and Atlas
   checksums. Keep the demo SQL and models isolated.
2. Unify the nine choices in one orchestrator. It must preview schema first,
   accept one record scope plus a procedure flag, and enforce stage order.
3. Finish all-record coverage using live table and constraint discovery.
   Verify experiment dependencies against both live schemas, including
   external parents and shared records.
4. Make retries explicit. Record completed stages, skip identical rows,
   reject differences, and report interrupted copy or procedure work exactly.
5. Test with disposable MariaDB source and target schemas containing current
   and legacy records, participants, windows, questions, notifications,
   external references, and procedures. Cover an empty target, populated
   target, ID collision, partial retry, drift, and failure after schema DDL.
   Run unit and integration checks in CI.
6. Run a read-only RDS preview with the selected experiment ID and review
   the counts and dependencies before any target write.

## Acceptance criteria

- All nine choices preview schema before their selected content stages.
- Records-only and procedures-only never register or apply schema SQL; they
  require matching schema and valid reviewed history before writing content.
- Schema-only changes no participant or application records.
- All-records mode copies every application base table and verifies content.
- Procedure mode copies only reviewed procedures after schema compatibility.
- One-experiment mode includes participants and every related current and
  legacy record found in the schema inventory; no unrelated experiment changes.
- Experiment-only mode can select any number of IDs or login codes, or all source experiments,
  preparing reviewed schema when needed but never copying stored procedures;
  all-experiments inserts are atomic.
- Failures report what committed, what rolled back, and how to resume. A
  second run never silently overwrites conflicting records.
- Local and CI integration tests pass, followed by a reviewed RDS preview.

## Implementation status and release gates

The unified CLI, schema-first gate, all-table copy, procedure policy, and
one-experiment dependency checks are implemented. The all-table copy leaves
foreign-key checks enabled and verifies content before each table commit.
The experiment path is atomic. Unit checks run locally.

The production schema baseline is still absent: migration-policy.json is
empty. It cannot be invented from the demo models. Live source and target
schema inspection, a selected experiment ID, reviewed production SQL and
procedure hashes, a disposable-MariaDB integration run, and a read-only RDS
preview remain release gates. No target write is authorized by this document.
Functions, triggers, views, and events are enumerated but intentionally not
executed until their scope is decided.
