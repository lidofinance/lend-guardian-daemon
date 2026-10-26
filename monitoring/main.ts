// The monitoring receiver: the daemon's events in, Prometheus metrics and JSON records out. README.md in
// this directory describes the configuration, the endpoints and the metrics.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { monitorConfig } from './config.ts';
import { isRecord } from './events.ts';
import { Metrics } from './metrics.ts';
import type { BuildInfo } from './metrics.ts';
import { Receiver } from './receiver.ts';
import { startServer } from './server.ts';

const UNKNOWN_BUILD: BuildInfo = { version: 'unknown', branch: 'unknown', commit: 'unknown' };

/** `build-info.json` is written next to `monitoring/` by the image build; a local run has none. */
export async function readBuildInfo(location: URL): Promise<BuildInfo> {
  let text: string;
  try {
    text = await readFile(location, 'utf8');
  } catch {
    return UNKNOWN_BUILD;
  }
  const record: unknown = JSON.parse(text);
  if (!isRecord(record)) {
    return UNKNOWN_BUILD;
  }
  return {
    version: field(record, 'version'),
    branch: field(record, 'branch'),
    commit: field(record, 'commit'),
  };
}

function field(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

async function main(): Promise<void> {
  const config = monitorConfig(process.env);
  const build = await readBuildInfo(new URL('../build-info.json', import.meta.url));
  const metrics = new Metrics(config.identity, build);
  const receiver = new Receiver({
    metrics,
    windows: { eventTimeoutMs: config.eventTimeoutSeconds * 1000, cycleTimeoutMs: config.cycleTimeoutSeconds * 1000 },
    sink: (line) => {
      console.log(line);
    },
  });
  const server = await startServer(config.port, { receiver, metrics, version: build.version });
  console.log(JSON.stringify({ event: 'monitor.started', level: 'info', build, config }));
  const stop = (): void => {
    server.close();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'monitor.failed', level: 'error', error: message }));
    process.exitCode = 1;
  }
}
