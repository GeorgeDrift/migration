# CloudShell Startup

VPC CloudShell remains temporary. These scripts automate repeated setup; they
do not make the environment permanent or preserve anything after it resets.

For the guided comparison and migration flow, use CLOUDSHELL-EASY.md instead.
This page describes setup-only use; bootstrap --run additionally opens the
guided launcher with explicit maintenance and migration confirmations.

## Publish Once

Push migration/cloudshell-start.sh, migration/cloudshell-bootstrap.sh and
migration/.gitattributes to migratio_rds_sequeliser+atlas first. They are not
available on GitHub until you publish your branch changes. Review the script
before executing it: it installs software and runs code from your private branch.

## After Every Reset

Keep the startup block in cloudshell-bootstrap.sh outside temporary CloudShell,
for example in your local worktree. Paste the whole block into CloudShell Bash
and run it there, not in Windows PowerShell and not by executing bash as a child
process. This preserves the database settings in your current shell.

The block installs GitHub CLI if missing, requests browser device login when
necessary, then retrieves the startup script through your authenticated GitHub
account. The branch name is passed as an API field so its plus sign is preserved.
Use GeorgeDrift in the browser. Do not put tokens or passwords into the block.
Github CLI can store its login credential locally; this is separate from the
database password, which the setup does not request or save.

The sourced startup script:

1. Checks for CloudShell's Git, curl, Node, npm and OpenSSL.
2. Clones the exact branch if missing. Bootstrap keeps an existing checkout as-is.
3. Stops for another origin/branch and warns about unpublished local changes.
4. Installs npm dependencies and runs the local tests.
5. Installs Atlas if missing; answer y to the Atlas installation prompt.
6. Downloads and validates the RDS CA certificate.
7. Exports default source/target settings, displays the actual configuration and
   leaves the terminal in ~/fabla-migration/migration.

It never connects to RDS, executes migration, creates AWS resources, enables
maintenance mode or configures a backup bucket. Existing explicit database
settings are respected; verify the displayed source and target before connecting.

Then run one line at a time:

```bash
read -r -s -p 'RDS admin password: ' MIGRATION_DB_PASSWORD
export MIGRATION_DB_PASSWORD
npm run compare
```

Comparison connects to RDS but is read-only. Writes still need approved schema
SQL, backup clients and the agreed recovery setup described in RECOVERY.md.

## Same Session

Do not reinstall everything just to run comparison again. If credentials and
settings remain in the same shell:

```bash
cd ~/fabla-migration/migration
npm run compare
```

For a clean clone update or full setup rerun in the same session:

```bash
source ~/fabla-migration/migration/cloudshell-start.sh
```

Local reviewed SQL/policy files are intentionally protected from updates.
Preserve them in an approved location before CloudShell ends; cloning cannot
recover files that were never published. A setup script cannot remove the need
to authenticate after a reset, and network access/permissions can still fail.

## Sources

- AWS VPC CloudShell storage constraints: https://docs.aws.amazon.com/cloudshell/latest/userguide/using-cshell-in-vpc.html
- GitHub CLI installation: https://github.com/cli/cli/blob/trunk/docs/install_linux.md
- GitHub CLI API fields and raw responses: https://cli.github.com/manual/gh_api
- Atlas installation: https://atlasgo.io/guides/evaluation/install
