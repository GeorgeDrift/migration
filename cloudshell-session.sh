#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf '%s\n' 'Run: source ~/fabla-migration/migration/cloudshell-session.sh' >&2
  exit 2
fi

set +x

_fabla_session() {
  local mode="${1:-}" source_user target_user
  case "$mode" in
    '') source "$HOME/fabla-migration/migration/cloudshell-start.sh" --keep-local || return 1 ;;
    --prepared) ;;
    *) printf '%s\n' 'Use no option or --prepared after successful setup.' >&2; return 1 ;;
  esac
  cd "$HOME/fabla-migration/migration" || return 1
  if [[ -z "${RDS_CA_BUNDLE:-}" || ! -r "$RDS_CA_BUNDLE" ]]; then
    printf '%s\n' 'Certificate is missing. Run the session launcher without --prepared.' >&2
    return 1
  fi
  source_user=$(node --input-type=module -e 'import {databaseConfigs} from "./database-config.mjs"; console.log(databaseConfigs().dev.user);') || return 1
  target_user=$(node --input-type=module -e 'import {databaseConfigs} from "./database-config.mjs"; console.log(databaseConfigs().target.user);') || return 1
  if [[ -z "${DEV_DB_PASSWORD:-${MIGRATION_DB_PASSWORD:-}}" ]]; then
    read -r -s -p "RDS source password for $source_user: " DEV_DB_PASSWORD || return 1
    printf '\n'
    [[ -n "$DEV_DB_PASSWORD" ]] || { printf '%s\n' 'Empty password; stopped.' >&2; return 1; }
  fi
  export DEV_DB_PASSWORD="${DEV_DB_PASSWORD:-$MIGRATION_DB_PASSWORD}"
  if [[ -z "${TARGET_DB_PASSWORD:-${MIGRATION_DB_PASSWORD:-}}" ]]; then
    if [[ "$source_user" == "$target_user" ]]; then
      TARGET_DB_PASSWORD="$DEV_DB_PASSWORD"
    else
      read -r -s -p "RDS target password for $target_user: " TARGET_DB_PASSWORD || return 1
      printf '\n'
      [[ -n "$TARGET_DB_PASSWORD" ]] || { printf '%s\n' 'Empty password; stopped.' >&2; return 1; }
    fi
  fi
  export TARGET_DB_PASSWORD="${TARGET_DB_PASSWORD:-$MIGRATION_DB_PASSWORD}"
  printf '%s\n' 'Database credentials are available for this shell session; no passwords were saved to disk.'
  bash "$HOME/fabla-migration/migration/cloudshell-run.sh" --prepared
}

if _fabla_session "$@"; then
  unset -f _fabla_session
  return 0
else
  unset -f _fabla_session
  printf '%s\n' 'Session launcher stopped. Inspect the error before retrying.' >&2
  return 1
fi
