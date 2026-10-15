// The daemon family: the transport family's observe cycle over loopback HTTP, run by the SDK alone and
// as daemon/main.ts runs it, with screening through its `HttpScreening` and every event serialized by
// `toRecord` and posted by `forward` to a receiver. The difference between the two runners is what the
// daemon adds to a cycle. The daemon also prints the events that are not routine RPC requests; the
// benchmark leaves that log out.

import { forward, toRecord } from '../daemon/main.ts';
import { HttpScreening } from '../daemon/screening.ts';
import type { SdkEvent } from '../src/core/index.ts';
import { startLoopback } from './loopback.ts';
import type { Loopback } from './loopback.ts';
import { ResourceWindow, check } from './metrics.ts';
import type { RunReport } from './metrics.ts';
import type { DaemonScenario } from './scenarios.ts';
import { realDelay } from './synthetic-rpc.ts';
import { CLEAN_SCREENING, observeGuardian, observeOnce } from './transport.ts';

/** The transport of the `observe-cycle` condition, with the daemon's 30-second request timeout. */
const OBSERVE_CYCLE = { condition: 'observe-cycle', timeoutMs: 30_000 } as const;

/** Longer than the five seconds after which the daemon gives up on a post. */
const DELIVERY_DEADLINE_MS = 15_000;

const POLL_INTERVAL_MS = 10;

export async function runDaemon(
  parameters: DaemonScenario,
  context: { readonly presetName: string; readonly scenarioId: string },
): Promise<RunReport> {
  const loopback = await startLoopback(context.presetName, context.scenarioId);
  try {
    return await daemonCycle(parameters, loopback);
  } finally {
    loopback.stop();
  }
}

/** One observe cycle by the scenario's runner, measured until the receiver has answered every event. */
async function daemonCycle(parameters: DaemonScenario, loopback: Loopback): Promise<RunReport> {
  const [nodeUrl = '', screeningUrl = '', eventsUrl = ''] = loopback.urls;
  const isDaemon = parameters.runner === 'daemon';
  let events = 0;
  const onEvent = (event: SdkEvent): void => {
    events += 1;
    if (isDaemon) {
      forward(eventsUrl, toRecord(event));
    }
  };
  const guardian = observeGuardian(OBSERVE_CYCLE, [nodeUrl], {
    screening: isDaemon ? new HttpScreening(screeningUrl) : CLEAN_SCREENING,
    onEvent,
  });
  const window = new ResourceWindow();
  const outcome = await observeOnce(guardian);
  // Posts outlast the cycle, so the window stays open until the receiver has answered each one.
  const received: Record<string, number> = isDaemon ? await waitForDeliveries(loopback, events) : {};
  const usage = window.close();
  const checks = [check('outcome', 'observed', outcome.kind), check('anchors', parameters.positions, outcome.anchors)];
  if (isDaemon) {
    checks.push(check('events received', events, received.eventPosts ?? 'none'));
    checks.push(check('posts left open', 0, received.postsInFlight ?? 'unknown'));
  }
  return {
    outcome: outcome.kind,
    metrics: { ...usage, anchors: outcome.anchors, events, ...received },
    rpcByPhase: {},
    checks,
  };
}

/** The receiver's counters once it holds every forwarded event and no post is open, or at the deadline. */
async function waitForDeliveries(loopback: Loopback, forwarded: number): Promise<Record<string, number>> {
  const deadline = performance.now() + DELIVERY_DEADLINE_MS;
  while (true) {
    const totals = await loopback.totals();
    const isSettled = totals.eventPosts === forwarded && totals.postsInFlight === 0;
    if (isSettled || performance.now() > deadline) {
      return totals;
    }
    await realDelay(POLL_INTERVAL_MS);
  }
}
