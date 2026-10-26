// The build identity: what the image build wrote is read back, and anything else is `unknown`.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBuildInfo } from '../../monitoring/build-info.ts';

const UNKNOWN = { version: 'unknown', branch: 'unknown', commit: 'unknown' };

/** A temporary directory for the life of `run`. */
function inDirectory(run: (write: (content: string) => string, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'guardian-daemon-build-info-'));
  const write = (content: string): string => {
    const path = join(directory, 'build-info.json');

    writeFileSync(path, content);

    return path;
  };

  try {
    run(write, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the version, branch and commit the image build wrote are read back', () => {
  inDirectory((write) => {
    const path = write(JSON.stringify({ version: 'dev', branch: 'develop', commit: '6ae855d9d5' }));

    assert.deepEqual(readBuildInfo(path), {
      version: 'dev',
      branch: 'develop',
      commit: '6ae855d9d5',
    });
  });
});

test('a placeholder, an empty value and a value of another type are unknown', () => {
  inDirectory((write) => {
    const path = write(JSON.stringify({ version: 'REPLACE_WITH_VERSION', branch: '', commit: 7 }));

    assert.deepEqual(readBuildInfo(path), UNKNOWN);
  });
});

test('a missing or malformed file is unknown', () => {
  inDirectory((write, directory) => {
    assert.deepEqual(readBuildInfo(join(directory, 'absent.json')), UNKNOWN);
    assert.deepEqual(readBuildInfo(write('{not json')), UNKNOWN);
    assert.deepEqual(readBuildInfo(write('[]')), UNKNOWN);
  });
});
