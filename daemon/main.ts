// The deployable daemon: the example's Guardian and schedule with screening over HTTP, SDK events to
// the log and to an optional receiver, and a liveness endpoint. README.md in this directory describes
// its configuration, contracts and limits.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Configuration } from '../example/configuration.ts';
import type { Mode, Setting, Settings } from '../example/configuration.ts';
import {
  createGuardian,
  GUARDIAN_SECRET_NAMES,
  GUARDIAN_SETTINGS,
  MAX_TIMER_MS,
  readDeployment,
  runCycles,
} from '../example/guardian.ts';
import type { GuardianDeployment, ScheduleEvent } from '../example/guardian.ts';
import { Secrets } from '../example/secrets.ts';
import type { Address, SdkEvent } from '../src/core/index.ts';
import {
  DEFAULT_SCREENING_BATCH_SIZE,
  DEFAULT_SCREENING_BUDGET_MS,
  DEFAULT_SCREENING_CONCURRENCY,
  HttpScreening,
  isRecord,
  MAX_SCREENING_TIMEOUT_MS,
} from './screening.ts';
import type { ScreeningRequestFinishedEvent } from './screening.ts';

// End HTTP screening before the SDK's wait, so the last request settles before the SDK times out.
const SCREENING_SETTLE_MARGIN_MS = 10_000;

/**
 * Every numeric setting of the daemon; README.md describes them. The example's settings keep their
 * meaning and defaults, except the longer screening wait for the daemon's HTTP batches.
 */
const DAEMON_SETTINGS = {
  ...GUARDIAN_SETTINGS,
  SCREENING_TIMEOUT_MS: {
    default: DEFAULT_SCREENING_BUDGET_MS + SCREENING_SETTLE_MARGIN_MS,
    min: SCREENING_SETTLE_MARGIN_MS + 1,
    max: MAX_TIMER_MS,
  },
  SCREENING_BATCH_SIZE: { default: DEFAULT_SCREENING_BATCH_SIZE, min: 1 },
  SCREENING_CONCURRENCY: { default: DEFAULT_SCREENING_CONCURRENCY, min: 1 },
  SCREENING_REQUEST_TIMEOUT_MS: { default: MAX_SCREENING_TIMEOUT_MS, min: 1, max: MAX_SCREENING_TIMEOUT_MS },
  FORWARD_TIMEOUT_MS: { default: 5_000, min: 1, max: MAX_TIMER_MS },
  HEALTH_PORT: { default: 8_080, min: 1, max: 65_535 },
  HEALTH_WINDOW_MS: { default: 10 * 60_000, min: 1 },
} satisfies Record<string, Setting>;

type DaemonSettings = Settings<typeof DAEMON_SETTINGS>;

/** The name of the application in the `User-Agent` of every request it sends. */
const APPLICATION_NAME = 'lend-guardian-daemon';

/** Written next to `daemon/` by the image build; a run from a checkout has none. */
const BUILD_INFO_FILE = new URL('../build-info.json', import.meta.url);

/** The image's build, as `Dockerfile` records it. */
export interface BuildInfo {
  readonly version: string;
  readonly branch: string;
  readonly commit: string;
}

const UNKNOWN_BUILD: BuildInfo = { version: 'unknown', branch: 'unknown', commit: 'unknown' };

/** What the daemon reports of its own, beside the SDK's, the schedule's and the screening's events. */
export type DaemonOwnEvent =
  | {
      /** The configuration the daemon runs with; it names no key and no URL. */
      readonly event: 'daemon.started';
      readonly build: BuildInfo;
      /** The JSON configuration file, when `CONFIG_FILE` names one. */
      readonly configFile: string | null;
      readonly mode: Mode;
      readonly chainId: number;
      readonly guardian: Address;
      readonly lidoLend: GuardianDeployment['lidoLend'];
      readonly guardianSignals: GuardianDeployment['guardianSignals'];
      /** The delegate's address in signal mode. */
      readonly signer: Address | null;
      readonly rpcUrlCount: number;
      readonly rpcLogQuorum: number | null;
      readonly rpcUserAgent: string;
      readonly hasEventsUrl: boolean;
      readonly settings: Readonly<Record<string, number>>;
    }
  | {
      /**
       * The posts to the receiver since the start, by the HTTP status of their answer, `0` without one,
       * and their total duration; a post the receiver lost is counted here.
       */
      readonly event: 'daemon.forwardsCounted';
      readonly posts: Readonly<Record<string, number>>;
      readonly durationMs: number;
    };

export type DaemonEvent = SdkEvent | ScheduleEvent | ScreeningRequestFinishedEvent | DaemonOwnEvent;

/** The events after which the daemon reports its post totals: each ends a scheduled cycle. */
const CYCLE_ENDS: ReadonlySet<DaemonEvent['event']> = new Set([
  'cycle.finished',
  'cycle.failed',
  'schedule.cycleNotStarted',
]);

/** Schedule [scan attempts](../docs/guardian-specification.md#scan-cycle) with HTTP screening and liveness. */
async function main(secrets: Secrets): Promise<void> {
  const config = Configuration.read(process.env);
  const mode = config.mode('MODE');
  const settings = config.readSettings(DAEMON_SETTINGS);
  const eventsUrl = config.url('EVENTS_URL', { default: undefined });
  // A shorter window would mark a working daemon as stuck while it waits for a cycle or a request.
  const healthWindowMs = settings('HEALTH_WINDOW_MS');
  if (healthWindowMs <= Math.max(settings('CYCLE_INTERVAL_MS'), settings('SCREENING_REQUEST_TIMEOUT_MS'))) {
    throw new Error('HEALTH_WINDOW_MS must be longer than CYCLE_INTERVAL_MS and SCREENING_REQUEST_TIMEOUT_MS');
  }
  const deployment = readDeployment(config, secrets, mode);
  const build = readBuildInfo(BUILD_INFO_FILE);
  const userAgent = `${APPLICATION_NAME}/${build.version}`;
  const reporter = new EventReporter({ eventsUrl, timeoutMs: settings('FORWARD_TIMEOUT_MS'), userAgent, secrets });
  let lastEventAt = Date.now();
  const onEvent = (event: DaemonEvent): void => {
    lastEventAt = Date.now();
    reporter.report(event);
  };
  const screening = new HttpScreening(config.url('SCREENING_URL'), {
    batchSize: settings('SCREENING_BATCH_SIZE'),
    concurrency: settings('SCREENING_CONCURRENCY'),
    timeoutMs: settings('SCREENING_REQUEST_TIMEOUT_MS'),
    budgetMs: settings('SCREENING_TIMEOUT_MS') - SCREENING_SETTLE_MARGIN_MS,
    userAgent,
    onEvent,
  });
  const rpcUserAgent = composeRpcUserAgent(config, userAgent);
  const guardian = createGuardian({ deployment, mode, onEvent, screening, settings, userAgent: rpcUserAgent });
  const hasEventsUrl = eventsUrl !== undefined;
  onEvent(
    describeStart({ build, configFile: config.configFile, deployment, mode, settings, rpcUserAgent, hasEventsUrl }),
  );
  // Liveness for Docker or Kubernetes. The server does not keep the process alive, so an error that
  // ends the cycles also ends the process; a port it cannot listen on ends it too.
  createServer((_request, response) => {
    const isActive = Date.now() - lastEventAt < healthWindowMs;
    response.writeHead(isActive ? 200 : 503).end();
  })
    .on('error', (error) => {
      printFailure(error, secrets);
      process.exit(1);
    })
    .listen(settings('HEALTH_PORT'))
    .unref();
  await runCycles({
    guardian,
    mode,
    cycleIntervalMs: settings('CYCLE_INTERVAL_MS'),
    maxRestarts: settings('MAX_RESTARTS_PER_CYCLE'),
    onEvent,
  });
}

/** The application's name first, so a provider always sees which program sends, then `RPC_USER_AGENT` when set. */
function composeRpcUserAgent(config: Configuration, userAgent: string): string {
  const operatorUserAgent = config.userAgent('RPC_USER_AGENT', { default: undefined });
  return operatorUserAgent === undefined ? userAgent : `${userAgent} ${operatorUserAgent}`;
}

/**
 * `build-info.json` of the image, or `unknown` for each field without one; a broken file stops the start.
 * `readBuildInfo` in `monitoring/main.ts` reads the receiver's by the same rule.
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

/** The start record of what the daemon read: endpoints are counted, never named, and the signer appears by its address. */
function describeStart(options: {
  readonly build: BuildInfo;
  readonly configFile: string | undefined;
  readonly deployment: GuardianDeployment;
  readonly mode: Mode;
  readonly settings: DaemonSettings;
  readonly rpcUserAgent: string;
  readonly hasEventsUrl: boolean;
}): DaemonOwnEvent {
  const { deployment, settings } = options;
  const names = Object.keys(DAEMON_SETTINGS).filter(isSettingName);
  return {
    event: 'daemon.started',
    build: options.build,
    configFile: options.configFile ?? null,
    mode: options.mode,
    chainId: deployment.chain.id,
    guardian: deployment.guardian,
    lidoLend: deployment.lidoLend,
    guardianSignals: deployment.guardianSignals,
    signer: deployment.signer?.address ?? null,
    rpcUrlCount: deployment.rpcUrls.length,
    rpcLogQuorum: deployment.rpcLogQuorum ?? null,
    rpcUserAgent: options.rpcUserAgent,
    hasEventsUrl: options.hasEventsUrl,
    settings: Object.fromEntries(names.map((name) => [name, settings(name)])),
  };
}

function isSettingName(name: string): name is keyof typeof DAEMON_SETTINGS {
  return Object.hasOwn(DAEMON_SETTINGS, name);
}

/** Where the daemon posts its records and how. */
interface ForwardOptions {
  /** The operator's receiver; without one the daemon only prints. */
  readonly eventsUrl: string | undefined;
  readonly timeoutMs: number;
  readonly userAgent: string;
  /** What each record masks. */
  readonly secrets: Secrets;
}

/**
 * Prints each event and posts it to the optional receiver, counting the posts by the status of their
 * answer. After each cycle it reports the totals, so the receiver learns of the posts it lost.
 */
export class EventReporter {
  readonly #options: ForwardOptions;

  readonly #postsByStatus = new Map<number, number>();

  #postDurationMs = 0;

  constructor(options: ForwardOptions) {
    this.#options = options;
  }

  /**
   * Print and forward one event, and after a cycle end the post totals. Routine RPC events go only to the
   * optional receiver; `isRoutine` in `monitoring/events.ts` leaves the same events out of its log.
   */
  report(event: DaemonEvent): void {
    const record = toRecord(event, this.#options.secrets);
    const isRpcStarted = event.event === 'rpc.requestStarted';
    const isRpcSucceeded = event.event === 'rpc.requestFinished' && event.error === undefined;
    if (!isRpcStarted && !isRpcSucceeded) {
      console.log(record);
    }
    if (this.#options.eventsUrl === undefined) {
      return;
    }
    this.#post(this.#options.eventsUrl, record);
    if (CYCLE_ENDS.has(event.event)) {
      const totals = toRecord(this.#describeForwards(), this.#options.secrets);
      console.log(totals);
      this.#post(this.#options.eventsUrl, totals);
    }
  }

  #post(eventsUrl: string, record: string): void {
    const startedAt = performance.now();
    const count = (status: number): void => {
      this.#postsByStatus.set(status, (this.#postsByStatus.get(status) ?? 0) + 1);
      this.#postDurationMs += performance.now() - startedAt;
    };
    // Delivery is best effort, with no queue or retries; README.md, Limitations, describes the loss.
    void fetch(eventsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': this.#options.userAgent },
      body: record,
      signal: AbortSignal.timeout(this.#options.timeoutMs),
    })
      .then(
        (response) => {
          count(response.status);
          // Only a read or cancelled body returns the connection to undici's pool.
          return response.body?.cancel();
        },
        () => {
          // The receiver answers for its own availability; a failed post is counted and the cycle goes on.
          count(0);
        },
      )
      .catch(() => {
        // A body that fails to cancel leaves only its connection unused.
      });
  }

  #describeForwards(): DaemonOwnEvent {
    const statuses = [...this.#postsByStatus.keys()].sort((left, right) => left - right);
    return {
      event: 'daemon.forwardsCounted',
      posts: Object.fromEntries(statuses.map((status) => [String(status), this.#postsByStatus.get(status) ?? 0])),
      durationMs: Math.round(this.#postDurationMs),
    };
  }
}

/**
 * JSON with decimal amounts, errors as their name, message and numeric code, such as a JSON-RPC error
 * code, and each secret masked, since an RPC error names its endpoint and a provider may repeat its key.
 */
export function toRecord(event: object, secrets: Secrets): string {
  return JSON.stringify(event, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'string') {
      return secrets.mask(value);
    }
    if (value instanceof Error) {
      const code = 'code' in value ? value.code : undefined;
      return { name: value.name, message: value.message, ...(typeof code === 'number' ? { code } : {}) };
    }
    return value;
  });
}

/** An error that ends the process; an RPC error names its endpoint, so it goes through the same mask as the events. */
function printFailure(error: unknown, secrets: Secrets): void {
  console.error(toRecord({ event: 'daemon.failed', error }, secrets));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A failure to read the secrets ends the process as Node prints it, and its error names the variable, never the value.
  const secrets = Secrets.read(GUARDIAN_SECRET_NAMES, process.env);
  try {
    await main(secrets);
  } catch (error) {
    // A configuration or recovery error ends the process, printed through the mask.
    printFailure(error, secrets);
    process.exitCode = 1;
  }
}
