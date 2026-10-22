// The timers of the SDK's races in a process with nothing else to wait for: they keep it alive until the race
// is decided and leave nothing behind once it is. The test runner's own activity would hide both in-process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runRace(mode: 'hanging-provider' | 'answering-provider' | 'hanging-signer') {
  return spawnSync(process.execPath, ['tests/core/fixtures/timer-race.ts', mode], {
    cwd: new URL('../../', import.meta.url),
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('a provider that never answers leaves its anchors incomplete although nothing else keeps the process alive', () => {
  const child = runRace('hanging-provider');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'incomplete 1');
});

test('a signer that never answers stops at the send deadline although nothing else keeps the process alive', () => {
  const child = runRace('hanging-signer');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'signing-timeout');
});

test('a provider that answers at once leaves no timer holding the process', () => {
  const child = runRace('answering-provider');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'incomplete 0');
});
