import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { readBuildInfo } from '../../monitoring/main.ts';
import { readInstalledVersions } from '../lock-files.ts';

const UNKNOWN = { version: 'unknown', branch: 'unknown', commit: 'unknown' };

/** A `build-info.json` holding the text, in a directory removed after the test. */
function writeBuildInfo(context: TestContext, text: string): URL {
  const directory = mkdtempSync(join(tmpdir(), 'monitoring-build-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'build-info.json');
  writeFileSync(file, text);
  return pathToFileURL(file);
}

test('build info is read from the image file', (context) => {
  const file = writeBuildInfo(context, JSON.stringify({ version: 'dev', branch: 'main', commit: 'c0ffee' }));
  assert.deepEqual(readBuildInfo(file), { version: 'dev', branch: 'main', commit: 'c0ffee' });
});

test('a field that is empty or absent reads as unknown', (context) => {
  assert.deepEqual(readBuildInfo(writeBuildInfo(context, JSON.stringify({ version: '' }))), UNKNOWN);
});

test('without the file, as in a run from a checkout, every field is unknown', (context) => {
  const missing = new URL('missing.json', writeBuildInfo(context, '{}'));
  assert.deepEqual(readBuildInfo(missing), UNKNOWN);
});

test('a file that is not a JSON object stops the start', (context) => {
  assert.throws(() => readBuildInfo(writeBuildInfo(context, '[1]')), {
    message: 'build-info.json must hold a JSON object',
  });
});

test('a file that is not JSON stops the start', (context) => {
  assert.throws(() => readBuildInfo(writeBuildInfo(context, '{')), SyntaxError);
});

test('the receiver image installs the dependency versions the tests run against', async () => {
  const tested = await readInstalledVersions('package-lock.json');
  const image = await readInstalledVersions('monitoring/package-lock.json');
  assert.ok(image.has('node_modules/@prometheus-io/client'), 'the image installs the Prometheus client');
  for (const [path, version] of image) {
    assert.equal(version, tested.get(path), `${path} in monitoring/package-lock.json`);
  }
});
