import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { monitorConfig } from '../../monitoring/config.ts';
import { readBuildInfo } from '../../monitoring/main.ts';

test('defaults apply when nothing is set and identity labels stay empty', () => {
  assert.deepEqual(monitorConfig({}), {
    port: 9464,
    eventTimeoutSeconds: 900,
    cycleTimeoutSeconds: 3600,
    identity: { guardian: '', mode: '', chainId: '' },
  });
});

test('set values are read and bounded', () => {
  const config = monitorConfig({
    MONITOR_PORT: '8080',
    MONITOR_EVENT_TIMEOUT_SECONDS: '60',
    MONITOR_CYCLE_TIMEOUT_SECONDS: '7200',
    GUARDIAN: ' 0xabc ',
    MODE: 'observe',
    CHAIN_ID: '1',
  });
  assert.equal(config.port, 8080);
  assert.equal(config.eventTimeoutSeconds, 60);
  assert.equal(config.cycleTimeoutSeconds, 7200);
  assert.deepEqual(config.identity, { guardian: '0xabc', mode: 'observe', chainId: '1' });
  assert.throws(() => monitorConfig({ MONITOR_PORT: '0' }), /MONITOR_PORT/);
  assert.throws(() => monitorConfig({ MONITOR_PORT: '70000' }), /MONITOR_PORT/);
  assert.throws(() => monitorConfig({ MONITOR_EVENT_TIMEOUT_SECONDS: '1.5' }), /MONITOR_EVENT_TIMEOUT_SECONDS/);
  assert.throws(() => monitorConfig({ MONITOR_CYCLE_TIMEOUT_SECONDS: 'soon' }), /MONITOR_CYCLE_TIMEOUT_SECONDS/);
});

test('build info is read from the image file and unknown without one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monitoring-'));
  const file = join(directory, 'build-info.json');
  await writeFile(file, JSON.stringify({ version: 'dev', branch: 'main', commit: 'c0ffee' }));
  assert.deepEqual(await readBuildInfo(pathToFileURL(file)), { version: 'dev', branch: 'main', commit: 'c0ffee' });
  await writeFile(file, JSON.stringify({ version: '' }));
  assert.deepEqual(await readBuildInfo(pathToFileURL(file)), {
    version: 'unknown',
    branch: 'unknown',
    commit: 'unknown',
  });
  const missing = pathToFileURL(join(directory, 'missing.json'));
  assert.deepEqual(await readBuildInfo(missing), { version: 'unknown', branch: 'unknown', commit: 'unknown' });
});
