#!/usr/bin/env bash

# Paste this complete block into a fresh CloudShell Bash terminal.
fabla_start() {
  local startup status mode="${1:-}"
  case "$mode" in
    ''|--run) ;;
    *) printf '%s\n' 'Unknown bootstrap option. Use --run or no option.' >&2; return 1 ;;
  esac
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
    printf '%s\n' 'Setup script could not be downloaded. Confirm it was pushed to your branch and your GitHub account has access.' >&2
    return 1
  fi
  source "$startup" --keep-local
  status=$?
  rm -f -- "$startup"
  [[ "$status" -eq 0 ]] || return "$status"
  if [[ "$mode" == '--run' ]]; then
    source "$HOME/fabla-migration/migration/cloudshell-session.sh" --prepared
    return "$?"
  fi
  return "$status"
}
if fabla_start "$@"; then
  unset -f fabla_start
else
  unset -f fabla_start
  printf '%s\n' 'Startup failed. Stop here and inspect the error; no migration was run.' >&2
  false
fi
