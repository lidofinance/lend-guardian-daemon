// The example: the Guardian on the application's schedule with a placeholder screening provider and
// a readable log. Start here, then read `guardian.ts` for the SDK setup and the schedule of cycles
// with its recovery; connect your provider in `screening.ts`. `../daemon/main.ts` runs the same
// Guardian and schedule as the deployable daemon.
//
// Start with observe mode; see README.md in this directory for configuration and provider wiring.

import { pathToFileURL } from 'node:url';
import type { CycleOutcome, SdkEvent } from '../src/core/index.ts';
import * as env from './env.ts';
import { createGuardian, GUARDIAN_SETTINGS, runCycles } from './guardian.ts';
import type { ScheduleEvent } from './guardian.ts';
import { screening } from './screening.ts';

const RPC_USER_AGENT = 'guardian-daemon-sdk-example';

/**
 * Schedule [scan attempts](../docs/guardian-specification.md#scan-cycle) with the placeholder screening.
 * The intervals are example policy and must be chosen for the operator's agreed SLA.
 */
async function main(): Promise<void> {
  const mode = env.mode('MODE');
  const settings = env.readSettings(GUARDIAN_SETTINGS);
  const guardian = createGuardian({ mode, onEvent: logEvent, screening, settings, userAgent: RPC_USER_AGENT });
  await runCycles({
    guardian,
    mode,
    cycleIntervalMs: settings('CYCLE_INTERVAL_MS'),
    maxRestarts: settings('MAX_RESTARTS_PER_CYCLE'),
    onEvent: logEvent,
  });
}

/** Keep the example's progress readable while retaining every lower-level SDK event. */
function logEvent(event: SdkEvent | ScheduleEvent): void {
  if (event.event === 'cycle.reconstructed') {
    console.log(`block ${event.reportBlock.number}: reconstructed ${event.anchors.length} supply anchors`);
    return;
  }
  if (event.event === 'cycle.finished') {
    console.log(describeOutcome(event.outcome));
    return;
  }
  if (event.event === 'cycle.failed') {
    console.error('cycle failed:', event.error);
    return;
  }
  if (event.event === 'schedule.cycleNotStarted') {
    // An error here comes from clearing the pending nonces: reconcile the signer.
    console.error('cycle not started:', event.error);
    return;
  }
  if (event.event === 'schedule.restartBudgetExhausted') {
    console.log(`plan stayed stale after ${String(event.restarts)} rebuilds: ${event.reason}`);
    return;
  }
  console.log(event);
}

/** One line on a completed call. */
function describeOutcome(outcome: CycleOutcome): string {
  switch (outcome.kind) {
    case 'observed': {
      const { screened } = outcome;
      return (
        `observed: ${screened.results.length} screened, ${screened.skipped.length} targets already flagged, ` +
        `${screened.suspects.length} suspects, ${screened.flags.length} flags; no transactions sent`
      );
    }
    case 'stale':
      return `plan went stale: ${outcome.reason}`;
    case 'nothing-due':
      return `nothing due: ${outcome.reason}`;
    case 'incomplete':
      // The reports the complete answers required are sent; the next cycle asks about the rest again.
      return `incomplete: ${outcome.incomplete.length} anchors without a complete answer; no heartbeat`;
    case 'attested':
      return `attested block ${outcome.previousHeartbeatBlock.number}: heartbeat ${outcome.heartbeat}, digest ${outcome.digest}`;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
