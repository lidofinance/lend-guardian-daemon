import { readFile } from 'node:fs/promises';
import { isRecord } from '../src/common/validation.ts';

/** The version of each package a lock file of this repository installs, by its path under `node_modules`. */
export async function readInstalledVersions(lockPath: string): Promise<Map<string, unknown>> {
  const lock: unknown = JSON.parse(await readFile(new URL(`../${lockPath}`, import.meta.url), 'utf8'));
  const packages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
  return new Map(
    Object.entries(packages)
      .filter(([path]) => path.startsWith('node_modules/'))
      .map(([path, entry]) => [path, isRecord(entry) ? entry.version : undefined]),
  );
}
