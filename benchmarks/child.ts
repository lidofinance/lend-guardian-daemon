// One benchmark scenario in an isolated process. The SDK's waits advance the synthetic chain's clock
// instead of sleeping, the scenario runs once, and its report goes to the parent over IPC, or to
// stdout when the child is started by hand for debugging:
//
//   node --expose-gc --experimental-test-module-mocks benchmarks/child.ts smoke '<scenario id>'
//
// With `--chain-url` and `--probe-operations` the process runs one probe of a griefing scenario against
// the chain server its parent started, so the probe has the heap limit of a measured process of its own.

import { mock } from 'node:test';
import * as realTimers from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_SERVER_MAX_OLD_SPACE_MB } from './chain-client.ts';
import { presetNamed, scenarioById } from './scenarios.ts';
import { SLOT_SECONDS, VirtualClock } from './synthetic-rpc.ts';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'server-max-old-space-mb': { type: 'string', default: String(DEFAULT_SERVER_MAX_OLD_SPACE_MB) },
      'chain-url': { type: 'string' },
      'probe-operations': { type: 'string' },
    },
  });
  const [presetName = '', scenarioId = ''] = positionals;
  const scenario = scenarioById(presetNamed(presetName), scenarioId);
  const clock = new VirtualClock({ slotSeconds: SLOT_SECONDS, realTimeScale: scenario.realTimeScale });
  // Guardian imports its poll timer from this module, so the mock must exist before the SDK loads.
  // Anvil runs keep real timers: a real chain mines blocks while the SDK waits.
  if (scenario.parameters.family !== 'anvil') {
    mock.module('node:timers/promises', {
      namedExports: {
        ...realTimers,
        setTimeout: (milliseconds: number, _value: unknown, options?: { readonly signal?: AbortSignal }) =>
          clock.sleep(milliseconds, options),
      },
    });
  }
  const { runGriefingProbe, runScenario } = await import('./workloads.ts');
  const run = { presetName, serverMaxOldSpaceMb: Number(values['server-max-old-space-mb']) };
  const chainUrl = values['chain-url'];
  if (chainUrl === undefined) {
    deliver(await runScenario(scenario, clock, run));
    return;
  }
  const operations = Number(values['probe-operations']);
  deliver(await runGriefingProbe(scenario, clock, run, { chainUrl, operations }));
}

/** Send the report and close the channel once it is flushed, so the process can exit. */
function deliver(report: object): void {
  if (process.send === undefined) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  process.send(report, undefined, {}, () => {
    process.disconnect();
  });
}

await main();
