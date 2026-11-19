import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Configuration } from '../../example/configuration.ts';

const TABLE = {
  GUARDIAN_TEST_INTERVAL_MS: { default: 360_000, min: 1, max: 2_147_483_647 },
  GUARDIAN_TEST_RESTARTS: { default: 5, min: 0 },
};

/** Write a file for this test only and return its path. */
function withFile(context: TestContext, text: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'guardian-configuration-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'value');
  writeFileSync(path, text);
  return path;
}

test('an unset setting reads as its default', () => {
  const settings = Configuration.read({}).readSettings(TABLE);
  assert.equal(settings('GUARDIAN_TEST_INTERVAL_MS'), 360_000);
  assert.equal(settings('GUARDIAN_TEST_RESTARTS'), 5);
});

test('a set setting reads as the integer its variable holds, zero included where the range allows it', () => {
  const config = Configuration.read({ GUARDIAN_TEST_INTERVAL_MS: '12000', GUARDIAN_TEST_RESTARTS: '0' });
  const settings = config.readSettings(TABLE);
  assert.equal(settings('GUARDIAN_TEST_INTERVAL_MS'), 12_000);
  assert.equal(settings('GUARDIAN_TEST_RESTARTS'), 0);
});

test('a setting out of its range is refused when the table is read, before any value is used', () => {
  const config = Configuration.read({ GUARDIAN_TEST_INTERVAL_MS: '2147483648' });
  assert.throws(() => config.readSettings(TABLE), {
    message: 'GUARDIAN_TEST_INTERVAL_MS must be an integer from 1 to 2147483647',
  });
});

test('a setting that is not a decimal integer is refused', () => {
  const config = Configuration.read({ GUARDIAN_TEST_RESTARTS: '1e2' });
  assert.throws(() => config.readSettings(TABLE), {
    message: 'GUARDIAN_TEST_RESTARTS must be an integer of at least 0',
  });
});

test('a required positive integer reads its decimal value', () => {
  const config = Configuration.read({ GUARDIAN_TEST_BLOCK: '16' });
  assert.equal(config.integer('GUARDIAN_TEST_BLOCK', { min: 1 }), 16);
});

test('a required positive integer that is unset is refused', () => {
  assert.throws(() => Configuration.read({}).integer('GUARDIAN_TEST_BLOCK', { min: 1 }), {
    message: 'GUARDIAN_TEST_BLOCK is not set',
  });
});

for (const text of ['0', '0x10', '1e3', ' 12 ', '5.0', '+7']) {
  test(`a required positive integer refuses ${JSON.stringify(text)} by the rule of a setting`, () => {
    const config = Configuration.read({ GUARDIAN_TEST_BLOCK: text });
    assert.throws(() => config.integer('GUARDIAN_TEST_BLOCK', { min: 1 }), {
      message: 'GUARDIAN_TEST_BLOCK must be an integer of at least 1',
    });
  });
}

test('a set user agent is read as it is', () => {
  const config = Configuration.read({ GUARDIAN_TEST_AGENT: 'partner-guardian/1.0' });
  assert.equal(config.userAgent('GUARDIAN_TEST_AGENT'), 'partner-guardian/1.0');
});

test('an unset variable reads as the default a reader is given, undefined included, and is refused without one', () => {
  const config = Configuration.read({});
  assert.equal(config.url('GUARDIAN_TEST_URL', { default: undefined }), undefined);
  assert.equal(config.userAgent('GUARDIAN_TEST_AGENT', { default: 'guardian-test' }), 'guardian-test');
  assert.equal(config.integer('GUARDIAN_TEST_BLOCK', { min: 1 }, { default: 7 }), 7);
  assert.throws(() => config.url('GUARDIAN_TEST_URL'), { message: 'GUARDIAN_TEST_URL is not set' });
});

test('a value the environment lacks is read from the configuration file, and a set variable wins over it', (context) => {
  const file = { GUARDIAN_TEST_BLOCK: 16, GUARDIAN_TEST_AGENT: 'file-agent', GUARDIAN_TEST_RESTARTS: '3' };
  const config = Configuration.read({
    CONFIG_FILE: withFile(context, JSON.stringify(file)),
    GUARDIAN_TEST_AGENT: 'env-agent',
  });
  assert.equal(config.integer('GUARDIAN_TEST_BLOCK', { min: 1 }), 16);
  assert.equal(config.userAgent('GUARDIAN_TEST_AGENT'), 'env-agent');
  const settings = config.readSettings(TABLE);
  assert.equal(settings('GUARDIAN_TEST_RESTARTS'), 3);
  assert.equal(settings('GUARDIAN_TEST_INTERVAL_MS'), 360_000);
});

test('the configuration file is read once, so a change to it after the start is not seen', (context) => {
  const path = withFile(context, '{"GUARDIAN_TEST_BLOCK": 16}');
  const config = Configuration.read({ CONFIG_FILE: path });
  writeFileSync(path, '{"GUARDIAN_TEST_BLOCK": 17}');
  assert.equal(config.integer('GUARDIAN_TEST_BLOCK', { min: 1 }), 16);
  assert.equal(config.configFile, path);
});

test('a value of the configuration file follows the rule of its variable', (context) => {
  const config = Configuration.read({ CONFIG_FILE: withFile(context, '{"GUARDIAN_TEST_BLOCK": 1.5}') });
  assert.throws(() => config.integer('GUARDIAN_TEST_BLOCK', { min: 1 }), {
    message: 'GUARDIAN_TEST_BLOCK must be an integer of at least 1',
  });
});

test('a configuration file with a value that is neither a string nor a number is refused when it is read', (context) => {
  const path = withFile(context, '{"GUARDIAN_TEST_BLOCK": 16, "GUARDIAN_TEST_UNUSED": true}');
  assert.throws(() => Configuration.read({ CONFIG_FILE: path }), {
    message: 'GUARDIAN_TEST_UNUSED in CONFIG_FILE must be a string or a number',
  });
});

for (const [text, message] of [
  ['{"GUARDIAN_TEST_BLOCK": ', 'CONFIG_FILE is not JSON'],
  ['[16]', 'CONFIG_FILE must hold a JSON object'],
  ['null', 'CONFIG_FILE must hold a JSON object'],
] as const) {
  test(`a configuration file holding ${JSON.stringify(text)} is refused when it is read`, (context) => {
    assert.throws(() => Configuration.read({ CONFIG_FILE: withFile(context, text) }), { message });
  });
}

test('a configuration file that cannot be read is refused', (context) => {
  const path = join(withFile(context, ''), 'missing.json');
  assert.throws(() => Configuration.read({ CONFIG_FILE: path }), { message: 'CONFIG_FILE cannot be read' });
});

test('a service URL is an HTTP or HTTPS URL, from its variable or the configuration file', (context) => {
  const config = Configuration.read({
    CONFIG_FILE: withFile(context, '{"GUARDIAN_TEST_URL": "https://screening.example/screen"}'),
    GUARDIAN_TEST_OTHER_URL: 'ftp://receiver.example/events',
  });
  assert.equal(config.url('GUARDIAN_TEST_URL'), 'https://screening.example/screen');
  assert.throws(() => config.url('GUARDIAN_TEST_OTHER_URL'), {
    message: 'GUARDIAN_TEST_OTHER_URL must be an HTTP or HTTPS URL',
  });
});
