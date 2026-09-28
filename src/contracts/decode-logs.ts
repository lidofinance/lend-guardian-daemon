import { parseEventLogs } from 'viem';
import type { Abi, ParseEventLogsReturnType } from 'viem';
import type { ChainLog } from '../chain/rpc.ts';
import { GuardianStop } from '../core/stop.ts';

/** Strict parsing alone skips malformed logs; complete evidence must account for every result. */
export function decodeLogs<const EventAbi extends Abi>(
  abi: EventAbi,
  raw: ChainLog[],
): ParseEventLogsReturnType<EventAbi, undefined, true> {
  const logs = parseEventLogs({ abi, logs: raw, strict: true });
  if (logs.length !== raw.length) {
    throw new GuardianStop('log-undecodable');
  }
  return logs;
}
