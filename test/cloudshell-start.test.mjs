import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const available = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
const setup = fileURLToPath(new URL('../cloudshell-start.sh', import.meta.url));
const bootstrap = fileURLToPath(new URL('../cloudshell-bootstrap.sh', import.meta.url));
const runner = fileURLToPath(new URL('../cloudshell-run.sh', import.meta.url));
const session = fileURLToPath(new URL('../cloudshell-session.sh', import.meta.url));
const easyGuide = fileURLToPath(new URL('../CLOUDSHELL-EASY.md', import.meta.url));

const mocks = `
_log() { printf '%s\\n' "$*" >> "$TEST_LOG"; }
command() {
  if [[ "$1" == '-v' && "$2" == 'gh' && "$FAKE_MISSING_GH" == '1' ]]; then return 1; fi
  if [[ "$1" == '-v' && "$2" == 'atlas' && "$FAKE_MISSING_ATLAS" == '1' ]]; then return 1; fi
  if [[ "$1" == '-v' && ( "$2" == 'mariadb-dump' || "$2" == 'mariadb' ) && "$FAKE_MISSING_CLIENTS" == '1' ]]; then return 1; fi
  builtin command "$@"
}
sudo() {
  _log "sudo $*"
  if [[ "$*" == 'dnf install -y gh' ]]; then FAKE_MISSING_GH=0; fi
  if [[ "$*" == 'dnf install -y mariadb105' ]]; then FAKE_MISSING_CLIENTS=0; fi
  return 0
}
gh() {
  _log "gh $*"
  case "$1 $2" in
    'auth status') [[ "$FAKE_SIGNED_OUT" != '1' ]] ;;
    'auth login') FAKE_SIGNED_OUT=0; return 0 ;;
    'repo clone') mkdir -p "$HOME/fabla-migration/migration"; builtin command cp "$SESSION_SCRIPT" "$HOME/fabla-migration/migration/cloudshell-session.sh"; return 0 ;;
    'api --method') [[ "$FAKE_API_FAILED" != '1' ]] || return 1; builtin command cat "$SETUP_SCRIPT"; return 0 ;;
    *) return 91 ;;
  esac
}
git() {
  _log "git $*"
  case "$3 $4" in
    'rev-parse --show-toplevel') (cd "$HOME/fabla-migration" && pwd -P) ;;
    'remote get-url') printf '%s\\n' "$FAKE_REMOTE" ;;
    'branch --show-current') printf '%s\\n' "$FAKE_BRANCH" ;;
    'status --porcelain') [[ "$FAKE_DIRTY" != '1' ]] || printf '%s\\n' ' M migration/migration-policy.json'; return 0 ;;
    'pull --ff-only') [[ "$FAKE_PULL_FAILED" != '1' ]] ;;
    *) return 92 ;;
  esac
}
npm() {
  _log "npm $*"
  if [[ "$*" == 'run migration:interactive' && "$MIGRATION_MAINTENANCE_TARGET" != 'migration_target' ]]; then return 98; fi
  [[ "$*" != "$FAKE_NPM_FAILURE" ]]
}
atlas() { _log "atlas $*"; return 0; }
sh() { _log 'sh Atlas installer'; return 0; }
curl() {
  _log "curl $*"
  local out
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == '-o' ]]; then out="$2"; shift; fi
    shift
  done
  [[ "$FAKE_DOWNLOAD_FAILED" != '1' ]] || return 1
  printf '%s\\n' 'MOCK CERTIFICATE OR INSTALLER' > "$out"
}
openssl() { _log "openssl $*"; [[ "$FAKE_BAD_CERT" != '1' ]]; }
node() {
  _log "node $*"
  case "$*" in
    *'console.log(databaseConfigs().dev.user)'*) printf '%s\\n' 'fixture-operator' ;;
    *'console.log(databaseConfigs().target.user)'*) printf '%s\\n' "\${FAKE_TARGET_USER:-fixture-operator}" ;;
    *'Guided shortcut only supports'*) [[ "$FAKE_WRONG_TARGET" != '1' ]] ;;
    *'recoveryDirectory();'*) [[ "$FAKE_INVALID_RECOVERY" != '1' ]] || return 1; mkdir -p "$MIGRATION_RECOVERY_DIR" ;;
    *) printf '%s\\n' 'Configuration displayed, no RDS connection' ;;
  esac
}
mariadb-dump() { _log "mariadb-dump $*"; return 0; }
mariadb() { _log "mariadb $*"; return 0; }
aws() {
  _log "aws $*"
  [[ "$FAKE_AWS_FAILED" != "$1 $2" ]] || return 1
  if [[ "$1 $2" == 's3 cp' ]]; then
    if [[ "$3" == s3://* ]]; then
      if [[ "$FAKE_CORRUPT_DOWNLOAD" == '1' ]]; then printf '%s\\n' corrupt > "$4";
      else printf '%s\\n' "$FAKE_OBJECT_CONTENT" > "$4"; fi
    else FAKE_OBJECT_CONTENT=$(builtin command cat "$3"); fi
  fi
}
bash() {
  _log "guided-child $*"
  if [[ "$FAKE_REQUIRE_SESSION_CREDS" == '1' ]]; then
    builtin command bash -c '[[ -n "$DEV_DB_PASSWORD" && -n "$TARGET_DB_PASSWORD" ]]' || return 97
  fi
  [[ "$FAKE_GUIDED_FAILURE" != '1' ]]
}
`;

function fixture(t, { existing = false, env = {}, file = setup, execute = false, args = [], input = '', script } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fabla-cloudshell-test-'));
  t.after(() => {
    const absolute = resolve(home);
    if (!absolute.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup path.');
    rmSync(absolute, { recursive: true, force: true });
  });
  if (existing) mkdirSync(join(home, 'fabla-migration', 'migration'), { recursive: true });
  if (existing) writeFileSync(join(home, 'fabla-migration', 'migration', 'cloudshell-start.sh'), readFileSync(setup));
  if (existing) writeFileSync(join(home, 'fabla-migration', 'migration', 'cloudshell-session.sh'), readFileSync(session));
  const log = join(home, 'commands.log');
  writeFileSync(log, '');
  if (script) {
    file = join(home, 'documented-start.sh');
    writeFileSync(file, script);
  }
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', mocks + (execute
    ? '\nbuiltin command bash "$RUN_SCRIPT"'
    : '\nsource "$RUN_SCRIPT" ' + args.map(arg => JSON.stringify(arg)).join(' ') + '\nstatus=$?\nprintf "RESULT:%s\\nHOST:%s\\nSOURCE:%s\\nTARGET:%s\\nPWD:%s\\n" "$status" "$MIGRATION_DB_HOST" "$MIGRATION_SOURCE_DB" "$MIGRATION_TARGET_DB" "$PWD"\nexit "$status"')], {
    env: { ...process.env, HOME: home, TEST_LOG: log, SETUP_SCRIPT: setup, SESSION_SCRIPT: session, RUN_SCRIPT: file,
      MIGRATION_DB_HOST: '', MIGRATION_DB_USER: '', MIGRATION_SOURCE_DB: '', MIGRATION_TARGET_DB: '',
      MIGRATION_DB_PASSWORD: '', DEV_DB_PASSWORD: '', TARGET_DB_PASSWORD: '',
      MIGRATION_RECOVERY_DIR: '', MIGRATION_RECOVERY_S3_URI: '',
      MIGRATION_MAINTENANCE_TARGET: '',
      FAKE_REMOTE: 'https://github.com/AppHatchery/FablaRdsNodeApi.git',
      FAKE_BRANCH: 'migratio_rds_sequeliser+atlas',
      ...env },
    encoding: 'utf8', timeout: 30000, input,
  });
  return { result, home, calls: readFileSync(log, 'utf8') };
}

test('CloudShell scripts have valid Bash syntax', { skip: !available }, () => {
  for (const path of [setup, bootstrap, runner, session]) {
    const result = spawnSync(bash, ['-n', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('fresh CloudShell setup clones the exact branch, configures defaults and never runs migration', { skip: !available }, t => {
  const { result, calls, home } = fixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /gh repo clone AppHatchery\/FablaRdsNodeApi .*--branch migratio_rds_sequeliser\+atlas --single-branch/);
  assert.match(calls, /npm ci/);
  assert.match(calls, /npm run check/);
  assert.match(result.stdout, /SOURCE:migration_dev/);
  assert.match(result.stdout, /TARGET:migration_target/);
  assert.ok(existsSync(join(home, 'us-east-1-bundle.pem')));
  assert.doesNotMatch(calls, /npm run (compare|migration)|FORBIDDEN AWS COMMAND|read -r/);
});

test('same-session clean clone updates with ff-only and skips installed tools', { skip: !available }, t => {
  const { result, calls } = fixture(t, { existing: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /git .*pull --ff-only origin migratio_rds_sequeliser\+atlas/);
  assert.doesNotMatch(calls, /repo clone|sudo dnf|sh Atlas installer/);
});

test('dirty clone, another branch or origin and failed pull stop without discarding files', { skip: !available }, t => {
  for (const env of [
    { FAKE_DIRTY: '1' }, { FAKE_BRANCH: 'main' },
    { FAKE_REMOTE: 'https://github.com/another/repo.git' }, { FAKE_PULL_FAILED: '1' },
  ]) {
    const { result, calls } = fixture(t, { existing: true, env });
    assert.equal(result.status, 1);
    assert.doesNotMatch(calls, /npm ci|checkout|reset|clean|FORBIDDEN AWS COMMAND/);
  }
});

test('missing tools and expired GitHub login are restored through interactive setup', { skip: !available }, t => {
  const { result, calls } = fixture(t, { env: {
    FAKE_MISSING_GH: '1', FAKE_SIGNED_OUT: '1', FAKE_MISSING_ATLAS: '1',
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /sudo dnf install -y gh/);
  assert.match(calls, /gh auth login --hostname github.com --git-protocol https --web/);
  assert.match(calls, /sh Atlas installer/);
});

test('dependency or certificate failures stop setup before reporting success', { skip: !available }, t => {
  for (const env of [{ FAKE_NPM_FAILURE: 'ci' }, { FAKE_NPM_FAILURE: 'run check' },
    { FAKE_BAD_CERT: '1' }, { FAKE_DOWNLOAD_FAILED: '1' }]) {
    const { result, home } = fixture(t, { env });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Setup complete/);
    assert.ok(!existsSync(join(home, 'us-east-1-bundle.pem')));
  }
});

test('reset startup block downloads private script with exact plus-sign branch and sources it', { skip: !available }, t => {
  const { result, calls } = fixture(t, { file: bootstrap, env: { FAKE_MISSING_GH: '1', FAKE_SIGNED_OUT: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /gh api --method GET --hostname github.com/);
  assert.match(calls, /-f ref=migratio_rds_sequeliser\+atlas/);
  assert.match(result.stdout, /SOURCE:migration_dev/);
  assert.match(result.stdout, /TARGET:migration_target/);
});

test('executing setup as a child shell fails with instructions to source it', { skip: !available }, t => {
  const { result, calls } = fixture(t, { execute: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Run: source/);
  assert.equal(calls, '');
});

test('bootstrap preserves failed download or setup status instead of reporting success', { skip: !available }, t => {
  for (const env of [{ FAKE_API_FAILED: '1' }, { FAKE_NPM_FAILURE: 'run check' }]) {
    const { result, calls } = fixture(t, { file: bootstrap, existing: true, env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Startup failed/);
    assert.doesNotMatch(calls, /npm run compare|FORBIDDEN AWS COMMAND/);
  }
});

test('keep-local setup preserves unpublished SQL and does not require GitHub login or pull', { skip: !available }, t => {
  const { result, calls } = fixture(t, { existing: true, args: ['--keep-local'],
    env: { FAKE_DIRTY: '1', FAKE_SIGNED_OUT: '1', FAKE_MISSING_GH: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Unpublished changes exist/);
  assert.doesNotMatch(calls, /gh auth|sudo dnf|pull --ff-only|reset|checkout|clean/);
});

test('guided run verifies S3, fetches checkpoints and compares before any menu execution', { skip: !available }, t => {
  const { result, calls } = fixture(t, { file: runner, existing: true, input: 'fixture-secret\ny\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /s3 cp .*--sse AES256/);
  assert.match(calls, /s3 sync .*--exclude _checks\/\*/);
  assert.match(calls, /npm run rollback -- list/);
  assert.ok(calls.indexOf('npm run compare') < calls.indexOf('npm run migration:interactive'));
  assert.equal(calls.match(/npm run compare/g).length, 2);
  assert.doesNotMatch(calls + result.stdout + result.stderr, /fixture-secret/);
  assert.doesNotMatch(calls, /aws .*create-bucket|mariadb-dump --host|reset|checkout|pull --ff-only/);
});

test('declining maintenance ends after comparison without requesting migration', { skip: !available }, t => {
  const { result, calls } = fixture(t, { file: runner, existing: true, input: 'fixture-secret\nn\n',
    env: { MIGRATION_MAINTENANCE_TARGET: 'migration_target' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Finished comparison only/);
  assert.doesNotMatch(calls, /npm run migration:interactive/);
});

test('S3 failure, corrupt downloads and invalid recovery paths block the menu', { skip: !available }, t => {
  for (const env of [{ FAKE_AWS_FAILED: 's3 cp' }, { FAKE_AWS_FAILED: 's3 sync' },
    { FAKE_CORRUPT_DOWNLOAD: '1' }, { FAKE_INVALID_RECOVERY: '1' }]) {
    const { result, calls } = fixture(t, { file: runner, existing: true, env, input: 'fixture-secret\ny\n' });
    assert.equal(result.status, 1);
    assert.doesNotMatch(calls, /npm run compare|npm run migration:interactive/);
  }
});

test('guided run refuses a different target and can install missing backup clients', { skip: !available }, t => {
  const refused = fixture(t, { file: runner, existing: true, env: { FAKE_WRONG_TARGET: '1' } });
  assert.equal(refused.result.status, 1);
  assert.doesNotMatch(refused.calls, /aws s3|npm run compare|npm run migration:interactive/);
  const installed = fixture(t, { file: runner, existing: true,
    env: { FAKE_MISSING_CLIENTS: '1' }, input: 'fixture-secret\nn\n' });
  assert.equal(installed.result.status, 0, installed.result.stderr);
  assert.match(installed.calls, /sudo dnf install -y mariadb105/);
});

test('explicit guided update stops on dirty files instead of discarding them', { skip: !available }, t => {
  const { result, calls } = fixture(t, { file: runner, existing: true, args: ['--update'], env: { FAKE_DIRTY: '1' } });
  assert.equal(result.status, 1);
  assert.doesNotMatch(calls, /pull --ff-only|aws s3|npm run migration:interactive|reset|checkout|clean/);
});

test('guided run reuses existing credentials and supports distinct database users', { skip: !available }, t => {
  const shared = fixture(t, { file: runner, existing: true,
    env: { MIGRATION_DB_PASSWORD: 'fixture-secret' }, input: 'n\n' });
  assert.equal(shared.result.status, 0, shared.result.stderr);
  assert.doesNotMatch(shared.result.stdout + shared.result.stderr + shared.calls, /fixture-secret/);
  const separate = fixture(t, { file: runner, existing: true,
    env: { FAKE_TARGET_USER: 'other-operator' }, input: 'source-secret\ntarget-secret\nn\n' });
  assert.equal(separate.result.status, 0, separate.result.stderr);
  assert.doesNotMatch(separate.result.stdout + separate.result.stderr + separate.calls, /source-secret|target-secret/);
});

test('failed comparison or migration stops the guided run without a success claim', { skip: !available }, t => {
  for (const failure of ['run compare', 'run migration:interactive', 'run rollback -- list']) {
    const { result, calls } = fixture(t, { file: runner, existing: true,
      env: { FAKE_NPM_FAILURE: failure }, input: 'fixture-secret\ny\n' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Guided run stopped/);
    if (failure !== 'run migration:interactive') assert.doesNotMatch(calls, /npm run migration:interactive/);
  }
});

test('bootstrap run mode opens the guided child only after successful setup', { skip: !available }, t => {
  const ready = fixture(t, { file: bootstrap, existing: true, args: ['--run'], input: 'fixture-secret\n' });
  assert.equal(ready.result.status, 0, ready.result.stderr);
  assert.match(ready.calls, /guided-child .*cloudshell-run.sh --prepared/);
  const failed = fixture(t, { file: bootstrap, existing: true, args: ['--run'], env: { FAKE_NPM_FAILURE: 'ci' } });
  assert.equal(failed.result.status, 1);
  assert.doesNotMatch(failed.calls, /guided-child/);
});

test('the documented reset block parses and opens the guided child after setup', { skip: !available }, t => {
  const blocks = [...readFileSync(easyGuide, 'utf8').matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .map(match => match[1]);
  for (const block of blocks) {
    const result = spawnSync(bash, ['-n'], { input: block, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const script = blocks.find(block => block.startsWith('fabla_start()'));
  assert.ok(script);
  const ready = fixture(t, { existing: true, script, input: 'fixture-secret\n' });
  assert.equal(ready.result.status, 0, ready.result.stderr);
  assert.match(ready.calls, /guided-child .*cloudshell-run.sh --prepared/);
  assert.doesNotMatch(ready.calls, /gh api .* \+ /);
  const failed = fixture(t, { existing: true, script, env: { FAKE_API_FAILED: '1' } });
  assert.equal(failed.result.status, 1);
  assert.doesNotMatch(failed.calls, /guided-child/);
});

test('sourced session launcher keeps exported credentials for a later comparison without printing or saving them', { skip: !available }, t => {
  const script = `
source "$HOME/fabla-migration/migration/cloudshell-session.sh" || return 1
[[ "$DEV_DB_PASSWORD" == 'fixture-secret' && "$TARGET_DB_PASSWORD" == "$DEV_DB_PASSWORD" ]] || return 3
builtin command bash -c '[[ -n "$DEV_DB_PASSWORD" && -n "$TARGET_DB_PASSWORD" ]]' || return 4
printf '%s\\n' 'PARENT_CREDENTIALS_READY'
npm run compare || return 5
`;
  const { result, calls, home } = fixture(t, { existing: true, script, input: 'fixture-secret\n',
    env: { FAKE_REQUIRE_SESSION_CREDS: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PARENT_CREDENTIALS_READY/);
  assert.match(calls, /guided-child .*cloudshell-run.sh --prepared/);
  assert.match(calls, /npm run compare/);
  assert.doesNotMatch(result.stdout + result.stderr + calls, /fixture-secret/);
  assert.ok(!existsSync(join(home, 'fabla-migration', 'migration', '.env.local')));
  assert.doesNotMatch(calls, /git .*pull|reset|checkout|clean/);
});

test('session credentials reuse existing passwords and support distinct users without secret output', { skip: !available }, t => {
  const existing = fixture(t, { file: session, existing: true, env: {
    MIGRATION_DB_PASSWORD: 'fixture-secret', FAKE_REQUIRE_SESSION_CREDS: '1' } });
  assert.equal(existing.result.status, 0, existing.result.stderr);
  const separate = fixture(t, { existing: true, input: 'source-secret\ntarget-secret\n',
    script: `source "$HOME/fabla-migration/migration/cloudshell-session.sh" || return 1
[[ "$DEV_DB_PASSWORD" == 'source-secret' && "$TARGET_DB_PASSWORD" == 'target-secret' ]] || return 3`,
    env: { FAKE_TARGET_USER: 'other-user', FAKE_REQUIRE_SESSION_CREDS: '1' } });
  assert.equal(separate.result.status, 0, separate.result.stderr);
  for (const f of [existing, separate]) {
    assert.doesNotMatch(f.result.stdout + f.result.stderr + f.calls, /fixture-secret|source-secret|target-secret/);
  }
});

test('session launcher rejects empty passwords or failed setup before starting a guided child', { skip: !available }, t => {
  for (const options of [{ input: '\n' }, { input: '' }, { env: { FAKE_NPM_FAILURE: 'ci' } }]) {
    const { result, calls } = fixture(t, { file: session, existing: true, ...options });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(calls, /guided-child/);
  }
  const executed = fixture(t, { file: session, existing: true, execute: true });
  assert.equal(executed.result.status, 2);
  assert.match(executed.result.stderr, /Run: source/);
});

test('session launcher preserves child failure and does not stop the caller shell', { skip: !available }, t => {
  const script = `
if source "$HOME/fabla-migration/migration/cloudshell-session.sh"; then return 6; fi
[[ -n "$DEV_DB_PASSWORD" && -n "$TARGET_DB_PASSWORD" ]] || return 7
printf '%s\\n' 'CALLER_STILL_RUNNING'
`;
  const { result } = fixture(t, { existing: true, script, input: 'fixture-secret\n', env: { FAKE_GUIDED_FAILURE: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Session launcher stopped/);
  assert.match(result.stdout, /CALLER_STILL_RUNNING/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/);
});
