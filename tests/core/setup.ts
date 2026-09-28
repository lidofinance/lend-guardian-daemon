import type { NodeEndpoint } from './client.ts';
// One place the phase tests build a Guardian from, so a change to the setup lands in one file.
import { signingClient } from './client.ts';
import type { Hex, RpcClient, RpcProvider } from '../../src/core/index.ts';
import { zeroAddress } from 'viem';
import { Guardian } from '../../src/core/guardian.ts';
import type { GuardianSetup } from '../../src/core/guardian.ts';
import type { ScreeningRequest, ScreeningResult } from '../../src/core/screening-provider.ts';
import { CHAIN_ID, CORE, fakeNode, GUARDIAN, GUARDIAN_KEY, REGISTRY } from './fake-node.ts';
import type { FakeNode, Script, Sent } from './fake-node.ts';

export const CORE_DEPLOYED = 1_000;

export const REGISTRY_DEPLOYED = 900;

export const IDLE_HEARTBEAT_SECONDS = 12 * 60 * 60;

/** The protocol's longest base activation delay, seven days: the lookback unless a test sets one. */

const TX_CONFIRMATIONS = 12;

const CLEAN: ScreeningResult = { status: 'judged', requiresSuspect: false, requiresFlag: false };

interface Built {
  readonly guardian: Guardian;
  readonly node: FakeNode;
  readonly sent: Sent;
}

/** A Guardian over a scripted node. `parts` replaces what a test is about, the rest is the default. */
export function guardianOver(
  script: Script,
  parts: Partial<GuardianSetup> & {
    privateKey?: Hex;
    endpoints?: readonly NodeEndpoint[];
    maxLogBlockRange?: number;
  } = {},
): Built {
  const node = fakeNode(script);
  const defaults = {
    deployment: {
      chainId: CHAIN_ID,
      slotSeconds: 12,
      lidoLend: { address: CORE, deploymentBlock: CORE_DEPLOYED },
      guardianSignals: { address: REGISTRY, deploymentBlock: REGISTRY_DEPLOYED },
    },
    guardian: GUARDIAN,

    expectedDelegate: zeroAddress,
    screening: {
      screen: (request: ScreeningRequest) => Promise.resolve(request.anchors.map(() => CLEAN)),
    },
    maxSignalBatchSize: 20,
    idleHeartbeatInterval: IDLE_HEARTBEAT_SECONDS,
    heartbeatReserveBlocks: 8,
    txConfirmationBlocks: TX_CONFIRMATIONS,
    ...parts,
  };
  if (parts.mode === 'observe') {
    if (parts.client === undefined) {
      throw new TypeError('observe fixture requires a client');
    }
    const setup: GuardianSetup = { ...defaults, mode: 'observe', client: parts.client };
    return { guardian: new Guardian(setup), node, sent: node.sent };
  }
  const configuredClient = parts.client;
  if (configuredClient !== undefined && !isRpcClient(configuredClient)) {
    throw new TypeError('signal fixture requires a signing client');
  }
  const client =
    configuredClient ??
    signingClient(
      parts.endpoints ?? [{ node: node.transport }],
      parts.privateKey ?? GUARDIAN_KEY,
      parts.maxLogBlockRange ?? 1_000_000,
      parts.onEvent,
    );
  const setup: GuardianSetup = { ...defaults, mode: 'signal', client };
  return { guardian: new Guardian(setup), node, sent: node.sent };
}

function isRpcClient(client: RpcProvider): client is RpcClient {
  return 'send' in client && typeof client.send === 'function';
}
