#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf '%s\n' 'Run: source migration/cloudshell-start.sh (or source ./cloudshell-start.sh from migration/).' >&2
  exit 2
fi

_fabla_cloudshell_setup() {
  local repo="$HOME/fabla-migration"
  local branch='migratio_rds_sequeliser+atlas'
  local remote current top temporary status
  local keep_local=0
  case "${1:-}" in
    '') ;;
    --keep-local) keep_local=1 ;;
    *) printf '%s\n' 'Unknown setup option. Use --keep-local or no option.' >&2; return 1 ;;
  esac

  for current in git curl node npm openssl; do
    if ! command -v "$current" >/dev/null 2>&1; then
      printf 'Required CloudShell tool is missing: %s. Stop and check the environment.\n' "$current" >&2
      return 1
    fi
  done
  if [[ "$keep_local" -eq 0 || ! -e "$repo" ]]; then
    if ! command -v gh >/dev/null 2>&1; then
      sudo dnf install -y 'dnf-command(config-manager)' || return 1
      sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo || return 1
      sudo dnf install -y gh || return 1
    fi
    if ! gh auth status --hostname github.com >/dev/null 2>&1; then
      gh auth login --hostname github.com --git-protocol https --web || return 1
    fi
    gh auth status --hostname github.com >/dev/null 2>&1 || return 1
  fi

  if [[ -L "$repo" ]]; then
    printf '%s\n' 'Refusing to update a symlinked clone. Preserve local files and inspect the path.' >&2
    return 1
  fi
  if [[ -e "$repo" ]]; then
    top=$(git -C "$repo" rev-parse --show-toplevel) || return 1
    current=$(cd "$repo" && pwd -P) || return 1
    if [[ "$top" != "$current" ]]; then
      printf '%s\n' 'Existing folder is not the expected repository root; nothing will be replaced.' >&2
      return 1
    fi
    remote=$(git -C "$repo" remote get-url origin) || return 1
    case "$remote" in
      https://github.com/AppHatchery/FablaRdsNodeApi.git|https://github.com/AppHatchery/FablaRdsNodeApi|git@github.com:AppHatchery/FablaRdsNodeApi.git) ;;
      *) printf '%s\n' 'Existing clone has a different origin; update cancelled.' >&2; return 1 ;;
    esac
    current=$(git -C "$repo" branch --show-current) || return 1
    if [[ "$current" != "$branch" ]]; then
      printf '%s\n' 'Existing clone is on another branch; no automatic checkout will be performed.' >&2
      return 1
    fi
    status=$(git -C "$repo" status --porcelain --untracked-files=all) || return 1
    if [[ -n "$status" && "$keep_local" -eq 0 ]]; then
      printf '%s\n' 'Local edits or untracked files exist. Preserve your reviewed SQL and policy before updating.' >&2
      printf '%s\n' "$status" >&2
      return 1
    fi
    if [[ "$keep_local" -eq 1 ]]; then
      printf '%s\n' 'Using this checkout without pulling or discarding local files.'
      if [[ -n "$status" ]]; then
        printf '%s\n' 'Unpublished changes exist. Save reviewed SQL, policy and checksums to GitHub before CloudShell resets.'
      fi
    else
      git -C "$repo" pull --ff-only origin "$branch" || return 1
    fi
  else
    gh repo clone AppHatchery/FablaRdsNodeApi "$repo" -- --branch "$branch" --single-branch || return 1
  fi
  cd "$repo/migration" || return 1
  npm ci || return 1
  npm run check || return 1

  if ! command -v atlas >/dev/null 2>&1; then
    temporary=$(mktemp /tmp/fabla-atlas-XXXXXX.sh) || return 1
    if ! curl -fsS --connect-timeout 15 --max-time 120 https://atlasgo.sh -o "$temporary"; then
      rm -f -- "$temporary"
      return 1
    fi
    sh "$temporary"
    status=$?
    rm -f -- "$temporary"
    [[ "$status" -eq 0 ]] || return 1
  fi
  atlas version || return 1

  export MIGRATION_DB_HOST="${MIGRATION_DB_HOST:-george-migration-dev.c1keeq28q8mb.us-east-1.rds.amazonaws.com}"
  export MIGRATION_DB_USER="${MIGRATION_DB_USER:-admin}"
  export MIGRATION_SOURCE_DB="${MIGRATION_SOURCE_DB:-migration_dev}"
  export MIGRATION_TARGET_DB="${MIGRATION_TARGET_DB:-migration_target}"
  export RDS_CA_BUNDLE="$HOME/us-east-1-bundle.pem"
  temporary=$(mktemp "$HOME/.fabla-rds-ca-XXXXXX") || return 1
  if ! curl -fsS --connect-timeout 15 --max-time 60 https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem -o "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  if ! openssl crl2pkcs7 -nocrl -certfile "$temporary" -outform PEM >/dev/null 2>&1; then
    printf '%s\n' 'Downloaded RDS certificate bundle is invalid; setup stopped.' >&2
    rm -f -- "$temporary"
    return 1
  fi
  mv -- "$temporary" "$RDS_CA_BUNDLE" || return 1
  node --input-type=module -e "import {databaseConfigs} from './database-config.mjs'; const d=databaseConfigs(); for(const [role,c] of Object.entries(d)) console.log(role+': '+c.schema+' on '+c.host+':'+c.port+' as '+c.user);" || return 1
  printf '%s\n' \
    'Setup complete. No RDS connection or migration was run.' \
    'Next, enter the RDS password and run the read-only comparison:' \
    "read -r -s -p 'RDS admin password: ' MIGRATION_DB_PASSWORD" \
    'export MIGRATION_DB_PASSWORD' \
    'npm run compare'
}

if _fabla_cloudshell_setup "$@"; then
  unset -f _fabla_cloudshell_setup
  return 0
else
  unset -f _fabla_cloudshell_setup
  printf '%s\n' 'Setup stopped. Resolve the error before comparison or migration.' >&2
  return 1
fi
