import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A promise that resolves after `ms`: the timer side of a race, whose caller decides in `then` what the
 * timeout does. The timer does not hold the process open, so work that finishes first leaves nothing
 * behind, and a result that comes later is dropped by the race.
 */
export function wait(ms: number): Promise<void> {
  return sleep(ms, undefined, { ref: false });
}
