# MariaDB numeric definition preservation

The source study table uses DOUBLE(10,2) for diary_incentive and bonus_amount.
Atlas's generated baseline previously emitted plain DOUBLE, and an Atlas schema
diff could show no SQL even though information_schema still reported that drift.
The migration tool must not treat those definitions as interchangeable.

schema-diff.mjs now reads the source's SHOW CREATE TABLE definitions and preserves
full sized DOUBLE/FLOAT column clauses in generated CREATE and ADD/MODIFY SQL.
If the target already has plain DOUBLE, it emits a corrective ALTER statement
even when Atlas produces an empty diff. This is generic across source tables:
it does not hard-code the study table or the two affected column names.
It preserves defaults, nullability, numeric modifiers and comments, and retains
other Atlas statements and index/foreign-key definitions.

Before Atlas applies selected migration files, run.mjs checks the relevant numeric
column definitions against the live source. Old lossy baselines are blocked before
apply. Applied files are never edited or automatically re-approved. Unsupported
numeric column renames and malformed SQL require manual review.

After publishing this code and pulling the branch in CloudShell, run:

```bash
node schema-diff.mjs
```

This is read-only. For the existing test target it should propose MODIFY COLUMN
clauses for the two study columns. Save and review the output as a NEW versioned
migration, register its exact SHA-256 in migration-policy.json, then refresh
atlas.sum with atlas migrate hash and validate it before applying. Do not replace
the existing approved baseline or reset Atlas history.

Numeric conversions can round or reject existing values. Classify them as
destructive when registering approval, back up the target first, and use the
protected workflow --allow-destructive execution guard. Changing code alone
does not repair the live target. Source and target schema verification remains
strict; numeric preservation does not guarantee fidelity for every SQL feature.
The separate checkpoint and restoration system is documented in RECOVERY.md.
Use the protected workflow rather than standalone run.mjs --execute.
Unit tests use fixtures and no AWS connections.
