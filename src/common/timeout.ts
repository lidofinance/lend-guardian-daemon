import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A promise that resolves after `ms`: the timer side of a race, whose caller decides in `then` what the
 * timeout does. The timer keeps the process alive, so a race whose other side never settles still ends;
 * the caller aborts `signal` once the race is decided, so work that finishes first leaves no timer behind.
 * A result that comes later is dropped by the race.
 */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return sleep(ms, undefined, { signal });
}
