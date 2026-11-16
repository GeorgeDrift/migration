import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('MariaDB drift fixtures drop the foreign key before reusing its name', () => {
  const script = readFileSync(new URL('../integration/mariadb.mjs', import.meta.url), 'utf8');
  const statements = [...script.matchAll(/await target\.query\('([^']+)'\);/g)]
    .map(match => match[1])
    .filter(sql => /^ALTER TABLE study (DROP FOREIGN KEY|ADD CONSTRAINT)/.test(sql));
  assert.deepEqual(statements, [
    'ALTER TABLE study DROP FOREIGN KEY study_ibfk_1',
    'ALTER TABLE study ADD CONSTRAINT study_ibfk_1 FOREIGN KEY (experiment_id) REFERENCES experiment(experiment_id) ON DELETE RESTRICT ON UPDATE RESTRICT',
    'ALTER TABLE study DROP FOREIGN KEY study_ibfk_1',
    'ALTER TABLE study ADD CONSTRAINT study_ibfk_1 FOREIGN KEY (experiment_id) REFERENCES experiment(experiment_id) ON DELETE CASCADE ON UPDATE RESTRICT',
  ]);
});

test('procedure fixture grants execution only on its routine after testing denial', () => {
  const script = readFileSync(new URL('../integration/mariadb.mjs', import.meta.url), 'utf8');
  const grants = [...script.matchAll(/await admin\.query\(`(GRANT[^`]+)`\);/g)].map(match => match[1]);
  assert.deepEqual(grants, [
    "GRANT SELECT ON ${quoteIdentifier(targetName)}.* TO ${quoteIdentifier(routineUser)}@'%'",
    "GRANT EXECUTE ON PROCEDURE ${quoteIdentifier(targetName)}.fixture_procedure TO ${quoteIdentifier(routineUser)}@'%'",
  ]);
  const denied = script.indexOf("await assert.rejects(target.query('CALL fixture_procedure()'), { code: 'ER_PROCACCESS_DENIED_ERROR' });");
  const grant = script.indexOf(grants[1]);
  const successfulCall = script.indexOf("assert.equal((await target.query('CALL fixture_procedure()'))");
  assert.ok(denied >= 0 && denied < grant && grant < successfulCall);
});

test('integration harness refuses remote endpoints and missing credentials before connecting', () => {
  const script = fileURLToPath(new URL('../integration/mariadb.mjs', import.meta.url));
  const cases = [
    { host: 'example.rds.amazonaws.com', password: 'disposable', error: /Never use RDS/ },
    { host: '', password: 'disposable', error: /loopback address/ },
    { host: '127.0.0.1', password: '', error: /isolated integration server password/ },
  ];
  for (const fixture of cases) {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, INTEGRATION_MARIADB_HOST: fixture.host,
        INTEGRATION_MARIADB_PASSWORD: fixture.password } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, fixture.error);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|ETIMEDOUT/);
  }
});
