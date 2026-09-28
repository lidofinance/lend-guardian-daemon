import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const configuredNpmCli = process.env.npm_execpath;
if (configuredNpmCli === undefined || configuredNpmCli === '') {
  throw new Error('Run this check through npm so it can reuse the active Node/npm toolchain');
}
const npmCli: string = configuredNpmCli;

const workspace = await mkdtemp(join(tmpdir(), 'guardian-sdk-package-'));
try {
  await npm(['pack', '--pack-destination', workspace], process.cwd());
  const archives = (await readdir(workspace)).filter((file) => file.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`Expected one package archive, found ${archives.length}`);
  }
  const archive = join(workspace, archives[0] ?? '');
  const consumer = join(workspace, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], consumer);
  await execute(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const core = await import('guardian-daemon-sdk/core'); const clients = await import('guardian-daemon-sdk/clients'); if (typeof core.Guardian !== 'function' || typeof core.BaseRpcProvider !== 'function' || typeof clients.ViemRpcClient !== 'function' || typeof clients.createViemRpcTransport !== 'function') throw new Error('package exports are incomplete');",
    ],
    { cwd: consumer },
  );
  const installed = join(consumer, 'node_modules', 'guardian-daemon-sdk');
  await Promise.all([
    access(join(installed, 'docs', 'guardian-specification.md')),
    access(join(installed, 'example', 'daemon.ts')),
    access(join(installed, 'src', 'core', 'guardian.ts')),
  ]);
  for (const path of ['audit-scope.md', 'docs/audit.md', 'tests']) {
    await assert.rejects(access(join(installed, path)), { code: 'ENOENT' });
  }
  console.log('Packed SDK installs cleanly and exposes /core, /clients, source and maintained documentation');
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function npm(arguments_: readonly string[], cwd: string): Promise<void> {
  await execute(process.execPath, [npmCli, ...arguments_], { cwd });
}
