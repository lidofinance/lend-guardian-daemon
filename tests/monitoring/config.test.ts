import assert from 'node:assert/strict';
import test from 'node:test';
import { readMonitorConfig } from '../../monitoring/config.ts';

test('defaults apply when nothing is set and identity labels stay empty', () => {
  assert.deepEqual(readMonitorConfig({}), {
    port: 9464,
    eventsPort: 9465,
    eventTimeoutSeconds: 900,
    cycleTimeoutSeconds: 3600,
    identity: { guardian: '', mode: '', chainId: '' },
  });
});

test('set values are read, and identity labels are trimmed', () => {
  const config = readMonitorConfig({
    MONITOR_PORT: '8080',
    MONITOR_EVENTS_PORT: '8081',
    MONITOR_EVENT_TIMEOUT_SECONDS: '60',
    MONITOR_CYCLE_TIMEOUT_SECONDS: '7200',
    GUARDIAN: ' 0xabc ',
    MODE: 'observe',
    CHAIN_ID: '1',
  });
  assert.deepEqual(config, {
    port: 8080,
    eventsPort: 8081,
    eventTimeoutSeconds: 60,
    cycleTimeoutSeconds: 7200,
    identity: { guardian: '0xabc', mode: 'observe', chainId: '1' },
  });
});

for (const [name, value, message] of [
  ['MONITOR_PORT', '0', 'MONITOR_PORT must be an integer from 1 to 65535'],
  ['MONITOR_PORT', '70000', 'MONITOR_PORT must be an integer from 1 to 65535'],
  ['MONITOR_EVENTS_PORT', '0', 'MONITOR_EVENTS_PORT must be an integer from 1 to 65535'],
  ['MONITOR_EVENTS_PORT', '9464', 'MONITOR_EVENTS_PORT must differ from MONITOR_PORT'],
  ['MONITOR_EVENT_TIMEOUT_SECONDS', '1.5', 'MONITOR_EVENT_TIMEOUT_SECONDS must be an integer from 1 to 2147483'],
  ['MONITOR_CYCLE_TIMEOUT_SECONDS', 'soon', 'MONITOR_CYCLE_TIMEOUT_SECONDS must be an integer from 1 to 2147483'],
] as const) {
  test(`${name}=${value} is refused`, () => {
    assert.throws(() => readMonitorConfig({ [name]: value }), { message });
  });
}
