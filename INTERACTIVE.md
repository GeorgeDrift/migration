# Interactive Migration Menu

From the migration directory, run:

```bash
npm run migration:interactive
```

For a local ignored `.env.local` configuration, use:

```bash
npm run migration:interactive:local
```

The menu uses the existing database environment variables, database passwords,
and `RDS_CA_BUNDLE`. It does not save passwords or install dependencies.
Set these before starting, just as for `node tool.mjs schema`.

The tool compares source and target first, then offers all nine workflow
choices. Enter a number from 1 through 9. Enter 10 or a blank selection to exit
(0 remains accepted for compatibility).
Option 8 is stored procedures only; option 9 is records only. These options
never create or alter table schema, and never copy the other content type.
They require a matching schema with no pending reviewed SQL or history errors.
Use option 1 or a combined schema-inclusive option to resolve schema differences
first. Procedure-only obtains exact procedure approvals with a y/N preview; records-only
still rejects conflicting rows. Backups and confirmation remain mandatory.
One-experiment workflows accept one positive experiment ID. Experiment-only
accepts comma-separated IDs, `code:LOGIN_CODE` values, or `all` (not combined
with individual selections).

Every selected action is previewed before execution. The selected workflow,
target database, and host are displayed before `Confirm migration? [y/N]:`.
Type `y` and press Enter to execute (`yes` is also accepted, case-insensitively).
Pressing Enter, typing `n`, or any unrecognized answer cancels. The existing
target confirmation and SQL/procedure approval policies remain enforced.

Choices containing procedures show the actual existing target connection account
and procedure SQL first, then ask whether to copy them with a y/N prompt. There
is no separate procedure password or mandatory definer setup. The account is
used as the definer: SQL SECURITY DEFINER procedures run with its permissions,
including admin permissions when connected as admin. Prefer a least-privilege
account in production. Explicit definer user/host overrides are optional as a pair.
Yes saves exact account-, SQL-mode- and endpoint-bound approvals only after a fresh
live preview. Changed definitions, account or policy require another review.
No skips procedures in a combined choice and displays the remaining schema/record
scope before final confirmation; for procedures-only it cancels without writes.
Procedure checks run before pending schema writes and again before content writes.

Schema-inclusive options prepare pending reviewed schema changes first when
required, including experiment-only. Records-only and procedures-only only
check schema compatibility; they never register or apply reconciliation SQL.
The selected target and schema scope are displayed
before confirmation. If target tables do not exist, the content preview is deferred
until schema has been applied and verified, then content is previewed and copied
in the same confirmed run. You do not need to select option 1 separately.
All selected content stages pass strict read-only preflight before the first
content stage writes. This checks known row conflicts and exact procedure
approvals. Changes made by other clients after preview can still cause failure.
For a schema-inclusive option, unreviewed differences lead to a generated
source-to-target SQL proposal after selection. Review the displayed SQL and approve it
explicitly, including potential data loss. The tool regenerates the diff and
checks that the SQL and local journal have not changed, then appends a new
hash-approved versioned migration and refreshes atlas.sum. Existing applied
files are never rewritten. You confirm execution separately; SQL approval
alone does not write to RDS.
Generated changes are conservatively classified as potentially destructive.
Existing destructive SQL also requires explicit approval in the menu.
An existing target without Atlas history needs a separate acknowledgement
before initial tracking starts; existing revision history is never reset.
Partial or unknown revisions, unsupported drift with no generated correction,
failed comparisons and failed previews still stop execution. Partial resume
remains a separate reviewed operator action.

Before reporting completion the tool compares schema again. This is not a full
verification of copied rows or procedure definitions. Writes now require the
durable checkpoint setup in RECOVERY.md. Each write stage saves the target first.
On a caught failure after writes, the tool attempts to restore and verify the
checkpoint from before the entire attempted workflow. The menu also offers the
latest, second-latest or third-latest saved stage checkpoint, with a y/N prompt.
These are saved states, not individual SQL statement undo steps.

Choose `R` at the menu (or accept the offer after a failure) to roll back on
demand. Option 1 is the fast schema undo: it previews the latest migration's
reviewed reverse SQL and runs it after a y/N prompt. Option 2 is the full
checkpoint restore above. When schema SQL is approved in the menu, its reverse
SQL is shown and approved with it. See "Fast Schema Undo" in RECOVERY.md.
Combined workflows are not atomic: restoration can fail or be interrupted.
Inspect the rollback status and preserve backups before retrying.
The generated SQL preserves sized DOUBLE/FLOAT source definitions, but all
remaining schema checks must pass before any content copying begins. One-to-one
schema verification is not permission to overwrite conflicting target records.

Changes in a local worktree are not automatically available in CloudShell.
Publish or transfer these files before running the command there. Preserve any
CloudShell-only SQL, approval policies, and test edits before updating its clone.
Approved generated SQL and its policy/checksum updates must be preserved before
temporary CloudShell resets. A failed local registration does not change RDS;
inspect the journal and refresh atlas.sum before retrying.

## Empty target after a test reset

An empty target with no tables, views, routines, triggers, events or Atlas history
can replay historical CREATE TABLE SQL without editing its approved bytes.
If an older CREATE loses sized DOUBLE/FLOAT definitions, the menu first proposes
an exact numeric ALTER correction to append after the historical files. Review
and approve it. The preview is a follow-up ALTER, not a duplicate CREATE of all
tables. Execution checks the complete approved replay chain before the first
schema write; approval covers potentially destructive corrections as usual.

This exception is only for a completely empty target. During replay its columns
can briefly have the historical types, but no records or procedures are copied
until all schema files finish and the final schema matches. Existing targets,
partial or unknown history, incomplete corrections, and unsupported historical
SQL cannot use this exception. Backups and automatic recovery remain required.
Once the correction is saved, later empty-target tests reuse the reviewed chain.
Publish the generated SQL, migration-policy.json and migrations/atlas.sum before
temporary CloudShell resets. Do not delete the RDS instance or migration_dev;
recreate only the disposable migration_target schema after a verified backup.
