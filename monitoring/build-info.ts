import { readFileSync } from 'node:fs';

export interface BuildInfo {
  readonly version: string;
  readonly branch: string;
  readonly commit: string;
}

/** Missing files, malformed JSON and build placeholders identify an unknown build. */
export function readBuildInfo(path: string | URL): BuildInfo {
  let source: unknown = {};
  try {
    source = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A checkout can have no build metadata.
  }
  if (!isRecord(source)) {
    return { version: 'unknown', branch: 'unknown', commit: 'unknown' };
  }
  return { version: named(source.version), branch: named(source.branch), commit: named(source.commit) };
}

function named(value: unknown): string {
  const known = typeof value === 'string' && value !== '';
  if (!known) {
    return 'unknown';
  }
  if (value.startsWith('REPLACE_WITH')) {
    return 'unknown';
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
