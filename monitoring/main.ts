// The monitoring receiver: the daemon's events in, Prometheus metrics and JSON records out. README.md in
// this directory describes the configuration, the endpoints and the metrics.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { BuildInfo } from '../daemon/main.ts';
import { readMonitorConfig } from './config.ts';
import { formatRecord, isRecord } from './events.ts';
import { Metrics } from './metrics.ts';
import { Receiver } from './receiver.ts';
import { startEventServer, startMonitoringServer } from './server.ts';

/** Written next to `monitoring/` by the image build; a run from a checkout has none. */
const BUILD_INFO_FILE = new URL('../build-info.json', import.meta.url);

const UNKNOWN_BUILD: BuildInfo = { version: 'unknown', branch: 'unknown', commit: 'unknown' };

/**
 * `build-info.json` of the image, or `unknown` for each field without one; a broken file stops the start.
 * `readBuildInfo` in `daemon/main.ts` reads the daemon's by the same rule; the receiver imports no daemon
 * code, so it keeps a copy.
 */
export function readBuildInfo(location: URL): BuildInfo {
  let text: string;
  try {
    text = readFileSync(location, 'utf8');
  } catch (error) {
    const isMissing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    if (isMissing) {
      return UNKNOWN_BUILD;
    }
    throw error;
  }
  const info: unknown = JSON.parse(text);
  if (!isRecord(info)) {
    throw new Error('build-info.json must hold a JSON object');
  }
  return { version: readText(info, 'version'), branch: readText(info, 'branch'), commit: readText(info, 'commit') };
}

function readText(info: Readonly<Record<string, unknown>>, name: string): string {
  const value = info[name];
  return typeof value === 'string' && value !== '' ? value : 'unknown';
}

async function main(): Promise<void> {
  const config = readMonitorConfig(process.env);
  const build = readBuildInfo(BUILD_INFO_FILE);
  const metrics = new Metrics(config.identity, build);
  const receiver = new Receiver({
    metrics,
    windows: { eventTimeoutMs: config.eventTimeoutSeconds * 1000, cycleTimeoutMs: config.cycleTimeoutSeconds * 1000 },
    sink: (line) => {
      console.log(line);
    },
  });
  const endpoints = { receiver, metrics, version: build.version };
  const servers = [
    await startEventServer(config.eventsPort, endpoints),
    await startMonitoringServer(config.port, '0.0.0.0', endpoints),
  ];
  console.log(formatRecord({ event: 'monitor.started', level: 'info', build, config }));
  const stop = (): void => {
    for (const server of servers) {
      server.close();
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(formatRecord({ event: 'monitor.failed', level: 'error', error: message }));
    // A server that did start would keep the process running.
    process.exit(1);
  }
}
