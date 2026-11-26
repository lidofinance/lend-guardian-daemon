import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readMonitorConfig } from '../../monitoring/config.ts';
import { formatRecord } from '../../monitoring/events.ts';

const GUARDIAN_SIGNALS = '0xF46eB3bf7783825B0ffb5f532C148A261Ec518a9';

const GUARDIAN = '0xA6b2dbCCE7895347A62b4409d29bA7ce29A74655';

/** The settings of a balance read, without the endpoints. */
const REGISTRY = { GUARDIAN_SIGNALS, GUARDIAN };

const RPC_URLS = 'https://first.example/v2/provider-key-0123456789, http://second.example:8545';

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

test('the balance source is the registry, the Guardian and the endpoints of RPC_URLS in their order', () => {
  assert.deepEqual(readMonitorConfig({ GUARDIAN_SIGNALS: ` ${GUARDIAN_SIGNALS} `, GUARDIAN, RPC_URLS }).balance, {
    registry: GUARDIAN_SIGNALS,
    guardian: GUARDIAN,
    rpcUrls: ['https://first.example/v2/provider-key-0123456789', 'http://second.example:8545'],
  });
});

test('the endpoints are read from the file RPC_URLS_FILE names, as an orchestrator mounts a secret', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'monitoring-rpc-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'rpc-urls');
  writeFileSync(file, `${RPC_URLS}\n`);
  assert.deepEqual(readMonitorConfig({ ...REGISTRY, RPC_URLS_FILE: file }).balance?.rpcUrls, [
    'https://first.example/v2/provider-key-0123456789',
    'http://second.example:8545',
  ]);
});

test('the start record of a configuration with endpoints names no URL', () => {
  const config = readMonitorConfig({ ...REGISTRY, RPC_URLS });
  const line = formatRecord({ event: 'monitor.started', level: 'info', config });
  assert.match(line, new RegExp(GUARDIAN_SIGNALS));
  assert.doesNotMatch(line, /example|provider-key/);
});

for (const [name, environment, message] of [
  ['GUARDIAN_SIGNALS without RPC_URLS', REGISTRY, 'GUARDIAN_SIGNALS and RPC_URLS must be set together'],
  ['RPC_URLS without GUARDIAN_SIGNALS', { GUARDIAN, RPC_URLS }, 'GUARDIAN_SIGNALS and RPC_URLS must be set together'],
  [
    'a GUARDIAN_SIGNALS that is no address',
    { GUARDIAN, GUARDIAN_SIGNALS: '0xabc', RPC_URLS },
    'GUARDIAN_SIGNALS must be a 20-byte hex address',
  ],
  [
    'a balance read without GUARDIAN',
    { GUARDIAN_SIGNALS, RPC_URLS },
    'GUARDIAN must be a 20-byte hex address for the balance read',
  ],
  [
    'a GUARDIAN that is no address',
    { GUARDIAN_SIGNALS, GUARDIAN: '0xabc', RPC_URLS },
    'GUARDIAN must be a 20-byte hex address for the balance read',
  ],
  [
    'RPC_URLS in both forms',
    { ...REGISTRY, RPC_URLS, RPC_URLS_FILE: '/nowhere' },
    'RPC_URLS and RPC_URLS_FILE are both set',
  ],
  ['a file that cannot be read', { ...REGISTRY, RPC_URLS_FILE: '/nowhere/rpc-urls' }, 'RPC_URLS_FILE cannot be read'],
  [
    'a URL of another scheme',
    { ...REGISTRY, RPC_URLS: 'ws://node.example' },
    'RPC_URLS must contain HTTP or HTTPS URLs',
  ],
  ['an empty URL', { ...REGISTRY, RPC_URLS: 'https://node.example,' }, 'RPC_URLS must contain HTTP or HTTPS URLs'],
] as const) {
  test(`${name} is refused`, () => {
    assert.throws(() => readMonitorConfig(environment), { message });
  });
}
