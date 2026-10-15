// One benchmark scenario in an isolated process. The SDK's waits advance the synthetic chain's clock
// instead of sleeping, the scenario runs once, and its report goes to the parent over IPC, or to
// stdout when the child is started by hand for debugging:
//
//   node --expose-gc --experimental-test-module-mocks benchmarks/child.ts smoke '<scenario id>'

import { mock } from 'node:test';
import * as realTimers from 'node:timers/promises';
import type { RunReport } from './metrics.ts';
import { presetNamed, scenarioById } from './scenarios.ts';
import { SLOT_SECONDS, VirtualClock } from './synthetic-rpc.ts';

async function main(): Promise<void> {
  const [presetName = '', scenarioId = ''] = process.argv.slice(2);
  const scenario = scenarioById(presetNamed(presetName), scenarioId);
  const clock = new VirtualClock({ slotSeconds: SLOT_SECONDS, realTimeScale: scenario.realTimeScale });
  // Guardian imports its poll timer from this module, so the mock must exist before the SDK loads.
  // Anvil runs keep real timers: a real chain mines blocks while the SDK waits.
  if (scenario.parameters.family !== 'anvil') {
    mock.module('node:timers/promises', {
      namedExports: {
        ...realTimers,
        setTimeout: (milliseconds: number, _value: unknown, options?: { readonly ref?: boolean }) =>
          clock.sleep(milliseconds, options),
      },
    });
  }
  const { runScenario } = await import('./workloads.ts');
  deliver(await runScenario(scenario, clock, presetName));
}

/** Send the report and close the channel once it is flushed, so the process can exit. */
function deliver(report: RunReport): void {
  if (process.send === undefined) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  process.send(report, undefined, {}, () => {
    process.disconnect();
  });
}

await main();
