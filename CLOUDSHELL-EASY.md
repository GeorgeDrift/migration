# Guided CloudShell Migration

This shortcut is restricted to migration_dev and migration_target on
george-migration-dev.c1keeq28q8mb.us-east-1.rds.amazonaws.com, port 3306.
The default backup location is:

    s3://migrationbackupmightdeletelater/george-migration/migration_target

It creates no AWS resources and does not run against production. Publish these
launcher changes to migratio_rds_sequeliser+atlas before using them in CloudShell.

## Existing Session: One Command

Run this from any directory in CloudShell Bash:

```bash
source ~/fabla-migration/migration/cloudshell-session.sh
```

The sourced entry point retains credentials in your current shell. After it
finishes, run comparisons without entering the password again:

```bash
npm run compare
```

The launcher checks the checkout, installs dependencies and missing tools,
validates the CA bundle, and uses the configured source and target usernames.
It requests a hidden RDS password only when one is not already available.
For the same database username the source password is reused for the target;
distinct users get separate prompts. Passwords are never written into the
repository, a settings file, or command arguments by this launcher.
This is session-wide access, not permanent credential storage. A VPC CloudShell
reset still removes its local files and shell variables. The RDS database and
S3 checkpoints remain separate from that temporary environment.
For compatibility, `npm run migration:guided` and `bash cloudshell-run.sh`
still work, but passwords entered inside their child shell do not transfer back
to your main prompt. Do not source cloudshell-run.sh directly; it uses exit.

It verifies encrypted S3 upload/download, downloads saved checkpoints outside
the repository, lists verified checkpoints, and prints the database comparison.
S3 probe objects remain under _checks; they are not database backups. S3 storage
and request charges still apply. Existing KMS settings are respected.

Answer y to open the menu only AFTER pausing all target writers. That prompt
does not pause applications, scheduled jobs or DBeaver operations for you.
Answer n or press Enter to finish with comparison only. The nine-option menu
still requires explicit SQL approval and execution confirmation. Actual target
checkpoints are created and verified by the migration engine before writes.
Option 8 copies only stored procedures; option 9 copies only records. Neither
applies schema changes. A matching schema and valid migration history are
required before either standalone choice can execute. Option 10 exits.
After a successful menu run the launcher prints a fresh database comparison.

Default runs keep the current checkout, including unpublished reviewed SQL.
They do not need a GitHub login when the clone already exists. To download code
updates explicitly, first preserve local changes and then use:

```bash
bash ~/fabla-migration/migration/cloudshell-run.sh --update
```

An update stops if the clone is dirty; it never resets or deletes your files.
The launcher does not automatically commit or push code. New approved migration
SQL, migration-policy.json and migrations/atlas.sum MUST be preserved in GitHub
before CloudShell resets, or RDS history can again refer to missing SQL files.

## Reset Session: One Startup Block

Temporary VPC CloudShell still loses its local installation and checkout after
reset. Run the complete block below in CloudShell Bash. It installs GitHub CLI
if needed, asks for browser device login, fetches the setup script from the
private branch, clones missing code, and opens the guided launcher. It does not
require pasting a GitHub token into the terminal. Review the branch code first.

```bash
fabla_start() {
  local startup status
  if ! command -v gh >/dev/null 2>&1; then
    sudo dnf install -y 'dnf-command(config-manager)' || return 1
    sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo || return 1
    sudo dnf install -y gh || return 1
  fi
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    gh auth login --hostname github.com --git-protocol https --web || return 1
  fi
  startup=$(mktemp /tmp/fabla-start-XXXXXX.sh) || return 1
  if ! gh api --method GET --hostname github.com \
    -H 'Accept: application/vnd.github.raw+json' \
    repos/AppHatchery/FablaRdsNodeApi/contents/migration/cloudshell-start.sh \
    -f 'ref=migratio_rds_sequeliser+atlas' > "$startup"; then
    rm -f -- "$startup"
    printf '%s\n' 'Cannot fetch the published startup script. Stop and check GitHub access.' >&2
    return 1
  fi
  source "$startup" --keep-local
  status=$?
  rm -f -- "$startup"
  [[ "$status" -eq 0 ]] || return "$status"
  source "$HOME/fabla-migration/migration/cloudshell-session.sh" --prepared
}
if fabla_start; then
  unset -f fabla_start
else
  unset -f fabla_start
  printf '%s\n' 'Startup or migration stopped. Inspect the error before retrying.' >&2
  false
fi
```

The password prompt runs in your main shell before opening the guided child,
so subsequent `npm run compare` commands inherit the same source/target credentials.
No password is hard-coded into this block. To clear credentials before leaving:

```bash
unset MIGRATION_DB_PASSWORD DEV_DB_PASSWORD TARGET_DB_PASSWORD
```

If the clone already exists but the helper file is absent, first pull the
published branch normally. Never use reset, clean, or checkout to discard locally
approved SQL. Stale history, invalid checksums, missing backups and failed S3
checks remain blocking errors rather than being bypassed by the launcher.

Only mock/offline launcher tests were run during implementation. Rehearse the
guided entry point against migration_target before considering other environments.
