// Which scenarios to profile: the slowest and the most memory-heavy of an earlier run, or scenarios
// named explicitly. Slowest means the largest median CPU time: the longest wall times belong to
// scenarios that mostly wait for timeouts, whose CPU profiles would show an idle process.

import { isRecord } from '../src/common/validation.ts';

export interface ProfileTarget {
  readonly id: string;
  /** Why the scenario was chosen, used as the profile directory name. */
  readonly reason: string;
  /** The median that selected it, in the metric's unit; zero for an explicit choice. */
  readonly median: number;
}

export interface ProfileSelection {
  readonly preset: string;
  readonly targets: readonly ProfileTarget[];
}

/** The scenario median of one metric, as `results.json` summarizes it. */
interface ScenarioMedian {
  readonly id: string;
  readonly median: number;
}

/** Select the scenarios with the largest median CPU time and the largest median peak RSS. */
export function profileTargetsOf(document: unknown): ProfileSelection {
  if (!isRecord(document) || !Array.isArray(document.scenarios)) {
    throw new TypeError('The results document has no scenarios');
  }
  const preset = isRecord(document.preset) ? document.preset.name : undefined;
  if (typeof preset !== 'string') {
    throw new TypeError('The results document names no preset');
  }
  const scenarios: readonly unknown[] = document.scenarios;
  const slowest = largestMedian(scenarios, 'cpuMs');
  const heaviest = largestMedian(scenarios, 'peakRssMb');
  const targets = [
    { id: slowest.id, reason: 'slowest', median: slowest.median },
    { id: heaviest.id, reason: 'memory-heavy', median: heaviest.median },
  ];
  return {
    preset,
    targets: targets.filter((target, index) => targets.findIndex((other) => other.id === target.id) === index),
  };
}

function largestMedian(scenarios: readonly unknown[], metric: string): ScenarioMedian {
  const medians = scenarios.flatMap((scenario) => {
    const median = medianOf(scenario, metric);
    return median === undefined ? [] : [median];
  });
  const largest = medians.reduce<ScenarioMedian | undefined>(
    (current, candidate) => (current === undefined || candidate.median > current.median ? candidate : current),
    undefined,
  );
  if (largest === undefined) {
    throw new TypeError(`No scenario in the results document has a ${metric} median`);
  }
  return largest;
}

function medianOf(scenario: unknown, metric: string): ScenarioMedian | undefined {
  if (!isRecord(scenario) || typeof scenario.id !== 'string') {
    return undefined;
  }
  const spread = isRecord(scenario.summary) ? scenario.summary[metric] : undefined;
  if (!isRecord(spread) || typeof spread.median !== 'number') {
    return undefined;
  }
  return { id: scenario.id, median: spread.median };
}
