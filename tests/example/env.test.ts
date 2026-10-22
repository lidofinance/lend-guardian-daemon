import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { integer, readSettings, url, userAgent } from '../../example/env.ts';

const TABLE = {
  GUARDIAN_TEST_INTERVAL_MS: { default: 360_000, min: 1, max: 2_147_483_647 },
  GUARDIAN_TEST_RESTARTS: { default: 5, min: 0 },
};

/** Set the variables for this test only. */
function withEnvironment(context: TestContext, values: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }
  context.after(() => {
    for (const name of Object.keys(values)) {
      Reflect.deleteProperty(process.env, name);
    }
  });
}

test('an unset setting reads as its default', () => {
  const settings = readSettings(TABLE);
  assert.equal(settings('GUARDIAN_TEST_INTERVAL_MS'), 360_000);
  assert.equal(settings('GUARDIAN_TEST_RESTARTS'), 5);
});

test('a set setting reads as the integer its variable holds, zero included where the range allows it', (context) => {
  withEnvironment(context, { GUARDIAN_TEST_INTERVAL_MS: '12000', GUARDIAN_TEST_RESTARTS: '0' });
  const settings = readSettings(TABLE);
  assert.equal(settings('GUARDIAN_TEST_INTERVAL_MS'), 12_000);
  assert.equal(settings('GUARDIAN_TEST_RESTARTS'), 0);
});

test('a setting out of its range is refused when the table is read, before any value is used', (context) => {
  withEnvironment(context, { GUARDIAN_TEST_INTERVAL_MS: '2147483648' });
  assert.throws(() => readSettings(TABLE), {
    message: 'GUARDIAN_TEST_INTERVAL_MS must be an integer from 1 to 2147483647',
  });
});

test('a setting that is not a decimal integer is refused', (context) => {
  withEnvironment(context, { GUARDIAN_TEST_RESTARTS: '1e2' });
  assert.throws(() => readSettings(TABLE), { message: 'GUARDIAN_TEST_RESTARTS must be an integer of at least 0' });
});

test('a required positive integer reads its decimal value', (context) => {
  withEnvironment(context, { GUARDIAN_TEST_BLOCK: '16' });
  assert.equal(integer('GUARDIAN_TEST_BLOCK', { min: 1 }), 16);
});

test('a required positive integer that is unset is refused', () => {
  assert.throws(() => integer('GUARDIAN_TEST_BLOCK', { min: 1 }), { message: 'GUARDIAN_TEST_BLOCK is not set' });
});

for (const text of ['0', '0x10', '1e3', ' 12 ', '5.0', '+7']) {
  test(`a required positive integer refuses ${JSON.stringify(text)} by the rule of a setting`, (context) => {
    withEnvironment(context, { GUARDIAN_TEST_BLOCK: text });
    assert.throws(() => integer('GUARDIAN_TEST_BLOCK', { min: 1 }), {
      message: 'GUARDIAN_TEST_BLOCK must be an integer of at least 1',
    });
  });
}

test('a set user agent is read as it is', (context) => {
  withEnvironment(context, { GUARDIAN_TEST_AGENT: 'partner-guardian/1.0' });
  assert.equal(userAgent('GUARDIAN_TEST_AGENT'), 'partner-guardian/1.0');
});

test('an unset variable reads as the default a reader is given, undefined included, and is refused without one', () => {
  assert.equal(url('GUARDIAN_TEST_URL', { default: undefined }), undefined);
  assert.equal(userAgent('GUARDIAN_TEST_AGENT', { default: 'guardian-test' }), 'guardian-test');
  assert.equal(integer('GUARDIAN_TEST_BLOCK', { min: 1 }, { default: 7 }), 7);
  assert.throws(() => url('GUARDIAN_TEST_URL'), { message: 'GUARDIAN_TEST_URL is not set' });
});
