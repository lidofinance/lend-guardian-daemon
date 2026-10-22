// One race of the SDK in a process with nothing else to wait for, so only the race's own timer can keep it
// alive. `node timer-race.ts hanging-provider | answering-provider | hanging-signer` prints the outcome.
import { createPublicClient, createWalletClient, custom } from 'viem';
import { toAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { ViemRpcClient } from '../../../src/chain/viem-client.ts';
import type { ScreeningResult } from '../../../src/core/index.ts';
import { blockAt, GUARDIAN, REGISTRY } from '../fake-node.ts';
import type { Script } from '../fake-node.ts';
import { guardianOver } from '../setup.ts';

const DUE: Script = {
  head: 200_000,
  guardianAddedAt: 1_000,
  lots: [
    {
      kind: 'activating',
      blockNumber: 199_000,
      logIndex: 4,
      amount: 5n,
      supplied: 5n,
      position: { dust: 0n, activating: 5n, activatingStart: blockAt(199_000).timestamp, activatingDelay: 60 },
    },
  ],
};

const CLEAN: ScreeningResult = { status: 'judged', requiresSuspect: false, requiresFlag: false };

/** Screen the due lot once, with a provider that never answers or one that answers at once. */
async function screenOnce(isHanging: boolean): Promise<string> {
  const { guardian } = guardianOver(DUE, {
    screening: {
      screen: (request) =>
        isHanging ? new Promise<ScreeningResult[]>(() => undefined) : Promise.resolve(request.anchors.map(() => CLEAN)),
    },
    // An answer at once must not leave a ten-minute timer holding the process.
    screeningTimeoutMs: isHanging ? 50 : 600_000,
  });
  const plan = await guardian.buildScanPlan();
  if (plan.kind !== 'plan') {
    throw new Error(`expected a plan, got ${plan.kind}`);
  }
  const screened = await guardian.screenWork(
    await guardian.reconstructWork(await guardian.discoverCandidatePositions(plan)),
  );
  return `incomplete ${String(screened.incomplete.length)}`;
}

/** Broadcast once through a signer that never answers. */
async function broadcastOnce(): Promise<string> {
  const transport = custom({ request: () => Promise.resolve('0x1') });
  const never = (): Promise<never> => new Promise(() => undefined);
  const account = toAccount({ address: GUARDIAN, signMessage: never, signTransaction: never, signTypedData: never });
  const client = new ViemRpcClient({
    publicClient: createPublicClient({ chain: mainnet, transport }),
    walletClient: createWalletClient({ account, chain: mainnet, transport }),
    maxLogBlockRange: 1_000,
    transactionPolicy: {
      sendTimeoutMs: 50,
      replacementFeeBumpBps: 1_000,
      maxFeePerGas: 1_000n,
      replacementTimeoutMs: 50,
      sendAttempts: 1,
    },
  });
  const transaction = { chainId: 1, to: REGISTRY, data: '0x', value: 0n, nonce: 0, gas: 21_000n } as const;
  try {
    await client.broadcastTransaction({ ...transaction, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, { attempt: 1 });
    return 'broadcast';
  } catch (error) {
    return error instanceof Error && 'reason' in error ? String(error.reason) : String(error);
  }
}

const mode = process.argv[2];
console.log(mode === 'hanging-signer' ? await broadcastOnce() : await screenOnce(mode === 'hanging-provider'));
