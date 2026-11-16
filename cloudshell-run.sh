#!/usr/bin/env bash

set +x
umask 077

_fabla_probe=''
_fabla_download=''
_fabla_summary=''
_fabla_cleanup() {
  [[ -z "$_fabla_probe" ]] || rm -f -- "$_fabla_probe"
  [[ -z "$_fabla_download" ]] || rm -f -- "$_fabla_download"
  [[ -z "$_fabla_summary" ]] || rm -f -- "$_fabla_summary"
}
trap _fabla_cleanup EXIT

_fabla_run() {
  local mode="${1:-}" setup_option='--keep-local' source_user target_user reply
  local setup="$HOME/fabla-migration/migration/cloudshell-start.sh"
  case "$mode" in
    ''|--prepared) ;;
    --update) setup_option='' ;;
    *) printf '%s\n' 'Usage: bash cloudshell-run.sh [--update]' >&2; return 2 ;;
  esac
  if [[ "$mode" != '--prepared' ]]; then
    if [[ ! -f "$setup" ]]; then
      printf '%s\n' 'The clone is missing. Use the fresh-session block in CLOUDSHELL-EASY.md.' >&2
      return 1
    fi
    if [[ -n "$setup_option" ]]; then
      source "$setup" "$setup_option" || return 1
    else
      source "$setup" || return 1
    fi
  fi
  cd "$HOME/fabla-migration/migration" || return 1
  unset MIGRATION_MAINTENANCE_TARGET

  # This shortcut is deliberately restricted to the confirmed test pair.
  node --input-type=module -e '
    import {databaseConfigs} from "./database-config.mjs";
    const d=databaseConfigs();
    const host="george-migration-dev.c1keeq28q8mb.us-east-1.rds.amazonaws.com";
    if(d.dev.host!==host || d.target.host!==host || d.dev.port!==3306 ||
       d.target.port!==3306 || d.dev.schema!=="migration_dev" || d.target.schema!=="migration_target") {
      console.error("Guided shortcut only supports the confirmed migration_dev to migration_target test pair.");
      process.exit(1);
    }
  ' || return 1
  command -v aws >/dev/null 2>&1 || { printf '%s\n' 'AWS CLI is required.' >&2; return 1; }
  if ! command -v mariadb-dump >/dev/null 2>&1 || ! command -v mariadb >/dev/null 2>&1; then
    sudo dnf install -y mariadb105 || return 1
  fi
  mariadb-dump --version || return 1
  mariadb --version || return 1

  source_user=$(node --input-type=module -e 'import {databaseConfigs} from "./database-config.mjs"; console.log(databaseConfigs().dev.user);') || return 1
  target_user=$(node --input-type=module -e 'import {databaseConfigs} from "./database-config.mjs"; console.log(databaseConfigs().target.user);') || return 1
  if [[ -z "${DEV_DB_PASSWORD:-${MIGRATION_DB_PASSWORD:-}}" ]]; then
    read -r -s -p "RDS source password for $source_user: " DEV_DB_PASSWORD || return 1
    printf '\n'
    [[ -n "$DEV_DB_PASSWORD" ]] || { printf '%s\n' 'Empty password; stopped.' >&2; return 1; }
    export DEV_DB_PASSWORD
  fi
  if [[ -z "${TARGET_DB_PASSWORD:-${MIGRATION_DB_PASSWORD:-}}" ]]; then
    if [[ "$source_user" == "$target_user" ]]; then
      export TARGET_DB_PASSWORD="${DEV_DB_PASSWORD:-$MIGRATION_DB_PASSWORD}"
    else
      read -r -s -p "RDS target password for $target_user: " TARGET_DB_PASSWORD || return 1
      printf '\n'
      [[ -n "$TARGET_DB_PASSWORD" ]] || { printf '%s\n' 'Empty password; stopped.' >&2; return 1; }
      export TARGET_DB_PASSWORD
    fi
  fi
  export MIGRATION_RECOVERY_S3_URI="${MIGRATION_RECOVERY_S3_URI:-s3://migrationbackupmightdeletelater/george-migration/migration_target}"
  export MIGRATION_RECOVERY_DIR="${MIGRATION_RECOVERY_DIR:-$HOME/migration-target-checkpoints}"
  node --input-type=module -e 'import {recoveryDirectory} from "./recovery.mjs"; recoveryDirectory();' || return 1
  chmod 700 "$MIGRATION_RECOVERY_DIR" || return 1
  printf 'Backup destination: %s\n' "$MIGRATION_RECOVERY_S3_URI"
  _fabla_probe=$(mktemp "$MIGRATION_RECOVERY_DIR/.access-check-XXXXXX") || return 1
  _fabla_download=$(mktemp "$MIGRATION_RECOVERY_DIR/.access-download-XXXXXX") || return 1
  printf 'Migration backup access check: %s\n' "$(basename "$_fabla_probe")" > "$_fabla_probe" || return 1
  local probe_uri="$MIGRATION_RECOVERY_S3_URI/_checks/$(basename "$_fabla_probe").txt"
  local -a encryption=(--sse AES256)
  if [[ -n "${MIGRATION_RECOVERY_KMS_KEY:-}" ]]; then
    encryption=(--sse aws:kms --sse-kms-key-id "$MIGRATION_RECOVERY_KMS_KEY")
  fi
  aws s3 cp "$_fabla_probe" "$probe_uri" "${encryption[@]}" --only-show-errors || return 1
  aws s3 cp "$probe_uri" "$_fabla_download" --only-show-errors || return 1
  if ! cmp -s "$_fabla_probe" "$_fabla_download"; then
    printf '%s\n' 'S3 download differs from upload; migration is blocked.' >&2
    return 1
  fi
  printf '%s\n' 'S3 upload and download verified. This is not a database checkpoint.'
  aws s3 sync "$MIGRATION_RECOVERY_S3_URI/" "$MIGRATION_RECOVERY_DIR/" --exclude '_checks/*' --only-show-errors || return 1
  npm run rollback -- list || return 1
  npm run compare || return 1
  printf '%s\n' 'The acknowledgement below does not stop external writers.'
  read -r -p 'Open migration menu with ALL migration_target writers paused? [y/N]: ' reply || return 1
  case "$reply" in
    y|Y|yes|YES|Yes) export MIGRATION_MAINTENANCE_TARGET='migration_target' ;;
    *) printf '%s\n' 'Finished comparison only. No migration was requested.'; return 0 ;;
  esac
  # tool.mjs writes what this run migrated here; it is repeated after the comparison as the final message.
  _fabla_summary=$(mktemp "$MIGRATION_RECOVERY_DIR/.migration-result-XXXXXX") || return 1
  export MIGRATION_SUMMARY_FILE="$_fabla_summary"
  npm run migration:interactive || return 1
  npm run compare || return 1
  printf '\n'
  if [[ -s "$_fabla_summary" ]]; then
    cat -- "$_fabla_summary"
  else
    printf '%s\n' 'MIGRATION RESULT: nothing was migrated in this session (cancelled, exited or already matching).'
  fi
  printf '%s\n' 'Preserve any new SQL, migration-policy.json and atlas.sum in GitHub before closing CloudShell.'
}

if _fabla_run "$@"; then
  exit 0
else
  status=$?
  printf '%s\n' 'Guided run stopped. Inspect the error; do not assume migration succeeded.' >&2
  exit "$status"
fi
