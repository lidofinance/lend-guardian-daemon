import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A promise that rejects with `error` after `ms`. The timer does not hold the process open, so a
 * result that comes first leaves nothing behind, and a result that comes later is dropped by the race.
 */
export function rejectAfter(ms: number, error: Error): Promise<never> {
  return sleep(ms, undefined, { ref: false }).then(() => {
    throw error;
  });
}
