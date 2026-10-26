import assert from 'node:assert/strict';
import test from 'node:test';
import { monitorConfig } from '../../monitoring/config.ts';

test('monitoring starts with no SDK configuration and ignores invalid SDK settings', () => {
  assert.deepEqual(monitorConfig({}), {
    port: 9464,
    progressTimeoutSeconds: 1800,
  });
  assert.deepEqual(
    monitorConfig({
      CHAIN_ID: 'invalid',
      GUARDIAN: 'invalid',
      MODE: 'invalid',
      RPC_URLS: 'invalid',
      GUARDIAN_SIGNER_PRIVATE_KEY: 'invalid',
      SCREENING_SERVICE_URL: 'invalid',
    }),
    monitorConfig({}),
  );
});

test('monitoring reads only its HTTP port and event freshness timeout', () => {
  assert.deepEqual(
    monitorConfig({
      MONITOR_PORT: '8081',
      MONITOR_PROGRESS_TIMEOUT_SECONDS: '600',
    }),
    {
      port: 8081,
      progressTimeoutSeconds: 600,
    },
  );
});

for (const name of ['MONITOR_PORT', 'MONITOR_PROGRESS_TIMEOUT_SECONDS']) {
  for (const value of ['', '-1', '0', '1.5', '1e3', '9007199254740992']) {
    test(`${name} rejects invalid numeric input without echoing it`, () => {
      assert.throws(() => monitorConfig({ [name]: value }), new RegExp(name));
    });
  }
}

test('monitoring rejects a port above the TCP port limit', () => {
  assert.throws(() => monitorConfig({ MONITOR_PORT: '65536' }), /MONITOR_PORT/);
});
