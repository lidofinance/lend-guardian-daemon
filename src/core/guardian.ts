// The [scan cycle](../../docs/guardian-specification.md#scan-cycle) has five phases and five public
// calls. The caller supplies the scheduler and recovery strategy, subject to the agreed scan/report
// SLA and failure requirements.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAddressEqual, zeroAddress } from 'viem';
import { Markets } from '../contracts/markets.ts';
import type { Lifecycle, Position, SupplyLog } from '../contracts/markets.ts';
import { GuardianSignals } from '../contracts/guardian-signals.ts';
import { BroadcastFailure, replacementFee } from '../chain/rpc.ts';
import type { PreparedTransaction, ReceiptRef, RpcClient, RpcProvider, TransactionAttempt } from '../chain/rpc.ts';
import { emitEvent } from '../events.ts';
import type { CycleContext, EventHandler, OperationContext, ReportContext, TransactionContext } from '../events.ts';
import type { PositionKey, SignalTarget, SupplyAnchor } from './types.ts';
import { Discovered, Screened, Work } from './outcomes.ts';
import type {
  Attested,
  CycleOutcome,
  Cursor,
  NothingDue,
  NothingDueReason,
  PendingTarget,
  Plan,
  ScreeningTargets,
  SkippedTarget,
  Stale,
  StaleReason,
} from './outcomes.ts';
import { coverageDigest } from './digest.ts';
import type { CoverageBounds } from './digest.ts';
import type { ScreeningProvider } from './screening-provider.ts';
import { GuardianStop } from './stop.ts';
import { lower } from '../common/types.ts';
import { requireDefined, requireInteger } from '../common/validation.ts';
import { frozenCopy } from '../common/immutable.ts';
import type { Address, BlockRef, Bytes32, ContractDeployment, MarketId } from '../common/types.ts';

type LifecycleEvents = AsyncGenerator<Lifecycle>;

/** A reconstructed anchor and the block where it entered `activating`. */
interface AnchorActivation {
  readonly anchor: SupplyAnchor;
  readonly activationBlock: bigint;
}

/** The deployment a Guardian screens. Every field is fixed for the life of the process. */
export interface Deployment {
  /**
   * The chain the nodes must serve, and committed to every coverage digest, so a commitment cannot
   * be replayed on another chain.
   */
  readonly chainId: number;
  /** Minimum seconds between blocks guaranteed by the network, not the observed average. */
  readonly slotSeconds: number;
  readonly lidoLend: ContractDeployment;
  readonly guardianSignals: ContractDeployment;
}

interface GuardianConfig {
  readonly deployment: Deployment;
  readonly guardian: Address;
  /** Where a deposit's risk is judged. */
  readonly screening: ScreeningProvider;
  /** Distance from the observed head to the report block. Defaults to 2. */
  readonly reportBlockLag?: number;
  /** Maximum concurrent flagger reads. Defaults to 8. */
  readonly flaggerReadConcurrency?: number;
  /** Confirmations between report batches, capped at txConfirmationBlocks. Defaults to 2. */
  readonly interBatchConfirmationBlocks?: number;
  /** Interval between shared report-confirmation checks. Defaults to one network slot. */
  readonly confirmationPollIntervalMs?: number;
  /** Seconds after the stored heartbeat before a cycle with no work heartbeats again. */
  readonly idleHeartbeatInterval: number;
  /** Blocks of the 256-block `blockhash` window reserved for the heartbeat's own inclusion. */
  readonly heartbeatReserveBlocks: number;
  /** Confirmations every required report must still have when the heartbeat is broadcast. */
  readonly txConfirmationBlocks: number;
  /** Borrowers per registry report transaction; grouping and ordering belong to Guardian. */
  readonly maxSignalBatchSize: number;
  /** Delivery observations and canonically confirmed actions; omitted when no observer is needed. */
  readonly onEvent?: EventHandler;
  /** Required in signal mode: the delegate the registry must name, or zero when none is expected. */
  readonly expectedDelegate?: Address | undefined;
}

/** Observe checks chain and membership; signal also signs and submits authorized registry writes. */
export type GuardianSetup = GuardianConfig &
  (
    | { readonly mode: 'observe'; readonly client: RpcProvider }
    | {
        /** Defaults to signal; an unsigned client can be used in observe mode. */
        readonly mode?: 'signal';
        /** The configured client owns its optional signing account and delivery policy. */
        readonly client: RpcClient;
      }
  );

/** How far back the EVM's `blockhash` opcode can still answer, which bounds a heartbeat's life. */
const BLOCKHASH_LOOKBACK = 256;

const DEFAULT_REPORT_BLOCK_LAG = 2;

const DEFAULT_FLAGGER_READ_CONCURRENCY = 8;

const DEFAULT_INTER_BATCH_CONFIRMATION_BLOCKS = 2;

const MILLISECONDS_PER_SECOND = 1_000;

// The supported profile follows the [fixed constants](../../docs/guardian-specification.md#fixed-constants).
const ACTIVATION_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

/** Configured defaults are resolved once; Guardian retains no signing material. */
type GuardianState = GuardianConfig &
  Required<
    Pick<
      GuardianConfig,
      'reportBlockLag' | 'flaggerReadConcurrency' | 'interBatchConfirmationBlocks' | 'confirmationPollIntervalMs'
    >
  > &
  (
    | { readonly mode: 'observe'; readonly client: RpcProvider }
    | { readonly mode: 'signal'; readonly client: RpcClient; readonly expectedDelegate: Address }
  );

/** Fixed gas for an EOA self-transfer with no calldata. */
const CANCELLATION_GAS = 21_000n;

export class Guardian {
  readonly #setup: GuardianState;

  readonly #rpc: RpcProvider;

  readonly #registry: GuardianSignals;

  readonly #lookbackBlocks: number;

  #isWriting = false;

  #activeCycle: CycleContext | undefined;

  // ─── The cycle: one attempt is these five calls, and the caller owns the loop between them.

  constructor(setup: GuardianSetup) {
    // Keep validated numeric values stable even if the caller later edits its setup object.
    this.#setup = snapshotSetup(setup);
    validateSetup(this.#setup);
    this.#lookbackBlocks = Math.ceil(ACTIVATION_LOOKBACK_SECONDS / this.#setup.deployment.slotSeconds);
    this.#rpc = this.#setup.client;
    this.#registry = new GuardianSignals({
      ...(this.#setup.mode === 'observe'
        ? { mode: 'observe' as const, client: this.#setup.client }
        : { mode: 'signal' as const, client: this.#setup.client }),
      chainId: this.#setup.deployment.chainId,
      deployment: this.#setup.deployment.guardianSignals,
      guardian: this.#setup.guardian,
    });
  }

  /**
   * Run one complete [scan cycle](../../docs/guardian-specification.md#scan-cycle). The caller owns
   * scheduling and recovery between calls; observe mode returns the screened result without writes.
   */
  async cycle(hint?: Cursor): Promise<CycleOutcome> {
    if (this.#activeCycle !== undefined) {
      throw new Error('another cycle is in progress');
    }
    const context = Object.freeze({ cycleId: randomUUID() });
    const startedAt = Date.now();
    this.#activeCycle = context;
    emitEvent(this.#setup.onEvent, { event: 'cycle.started', ...context, startedAt });
    try {
      const planned = await this.buildScanPlan(hint);
      if (planned.kind === 'nothing-due') {
        const outcome = frozenCopy(planned);
        emitEvent(this.#setup.onEvent, { event: 'cycle.planned', ...context, result: outcome });
        emitEvent(this.#setup.onEvent, {
          event: 'cycle.finished',
          ...context,
          startedAt,
          finishedAt: Date.now(),
          outcome,
        });
        return outcome;
      }
      const plan = planned;
      emitEvent(this.#setup.onEvent, { event: 'cycle.planned', ...context, result: plan });

      const discovered = await this.discoverCandidatePositions(plan);
      emitEvent(this.#setup.onEvent, {
        event: 'cycle.discovered',
        ...context,
        reportBlock: plan.reportBlock,
        positions: discovered.all(),
      });
      const work = await this.reconstructWork(discovered);
      emitEvent(this.#setup.onEvent, {
        event: 'cycle.reconstructed',
        ...context,
        reportBlock: work.reportBlock,
        positions: work.positions,
        anchors: work.all(),
      });
      const screened = await this.screenWork(work);
      emitEvent(this.#setup.onEvent, {
        event: 'cycle.screened',
        ...context,
        reportBlock: work.reportBlock,
        results: screened.results,
        skipped: screened.skipped,
        suspects: screened.suspects,
        flags: screened.flags,
      });
      const outcome: CycleOutcome =
        this.#setup.mode === 'observe'
          ? Object.freeze({ kind: 'observed', cursor: frozenCopy(hint), screened })
          : frozenCopy(await this.signalAndHeartbeat(screened));
      emitEvent(this.#setup.onEvent, {
        event: 'cycle.finished',
        ...context,
        startedAt,
        finishedAt: Date.now(),
        outcome,
      });
      return outcome;
    } catch (error) {
      emitEvent(this.#setup.onEvent, {
        event: 'cycle.failed',
        ...context,
        startedAt,
        finishedAt: Date.now(),
        error,
      });
      throw error;
    } finally {
      this.#activeCycle = undefined;
    }
  }

  /**
   * Choose coverage and recover the prior heartbeat: [scan phase 1](../../docs/guardian-specification.md#scan-cycle)
   * and [Appendix A](../../docs/guardian-specification.md#a-build-the-scan-plan).
   * The SDK's optional cursor only narrows the event search; chain evidence still establishes coverage.
   */
  async buildScanPlan(hint?: Cursor): Promise<Plan | NothingDue> {
    const observed = await this.#rpc.getBlock();
    await this.#requireConfigured(observed.hash);

    const storedTimestamp = await this.#registry.storedHeartbeat(observed.hash);
    const coverage = await this.#coverageThrough(storedTimestamp, observed, hint);
    const cursor: Cursor = { coverageThrough: coverage, storedTimestamp, verifiedAt: observed };

    const { deploymentBlock } = this.#setup.deployment.lidoLend;
    const { reportBlockLag } = this.#setup;
    if (observed.number - reportBlockLag < deploymentBlock) {
      return nothingDue(cursor, 'report-block-before-core-deployment');
    }
    const reportBlock = await this.#rpc.getBlock(observed.number - reportBlockLag);
    if (reportBlock.timestamp <= storedTimestamp) {
      return nothingDue(cursor, 'report-block-not-past-stored-heartbeat');
    }
    return this.#planFrom(cursor, reportBlock);
  }

  /**
   * Find the positions that may be due: [scan phase 2](../../docs/guardian-specification.md#scan-cycle)
   * and [Appendix B](../../docs/guardian-specification.md#b-discover-candidate-positions).
   */
  async discoverCandidatePositions(plan: Plan): Promise<Discovered> {
    const markets = new Markets(this.#rpc, this.#setup.deployment.lidoLend);
    await this.#requireBlock(plan.reportBlock);
    const supplies = await markets.supplies({
      fromBlock: plan.discoveryFrom.number,
      toBlock: plan.reportBlock.number,
    });
    await this.#requireBlock(plan.reportBlock);
    const candidatesByPosition = new Map<string, PositionKey>();
    for (const supply of supplies) {
      const position = await this.#candidateOf(plan, supply, markets);
      if (position !== null) {
        candidatesByPosition.set(`${position.marketId}:${position.borrower}`, position);
      }
    }
    return new Discovered(plan, [...candidatesByPosition.values()]);
  }

  /**
   * Rebuild the contributing supplies: [scan phase 3](../../docs/guardian-specification.md#scan-cycle)
   * and [Appendix C](../../docs/guardian-specification.md#c-reconstruct-the-contributors).
   */
  async reconstructWork(discovered: Discovered): Promise<Work> {
    const plan = discovered.plan();
    const markets = new Markets(this.#rpc, this.#setup.deployment.lidoLend);
    const byPosition = new Map<PositionKey, readonly SupplyAnchor[]>();
    for (const position of discovered.all()) {
      const anchors = await this.#reconstructPosition(plan, position, markets);
      if (anchors.length > 0) {
        byPosition.set(position, anchors);
      }
    }
    return new Work(plan, byPosition);
  }

  /**
   * Resolve [scan phase 4](../../docs/guardian-specification.md#scan-cycle): this Guardian's own flags
   * skip provider screening for their targets; every remaining anchor needs a complete decision.
   * The [provider boundary](../../docs/guardian-specification.md#screening-provider) leaves risk policy
   * to the adapter. Skipped anchors remain in Work and therefore in the heartbeat's coverage digest.
   */
  async screenWork(work: Work): Promise<Screened> {
    const { pending, skipped } = await this.#screeningTargets(work);
    const anchors = pending.flatMap((entry) => entry.anchors);
    // SDK safeguard: frozen request copies keep provider edits from changing the original anchor
    // order or reconstructed state. Positional results replace the appendix's anchor-keyed map.
    const request = frozenCopy({
      chainId: this.#setup.deployment.chainId,
      reportBlock: work.reportBlock,
      anchors,
    });
    const answers = anchors.length === 0 ? [] : await this.#setup.screening.screen(request);
    return Screened.fromAnswers(work, { pending, skipped }, answers);
  }

  /**
   * Complete [scan phase 5](../../docs/guardian-specification.md#scan-cycle) and the
   * [heartbeat requirements](../../docs/guardian-specification.md#heartbeat-requirements).
   * [Appendix D](../../docs/guardian-specification.md#d-submit-signals-and-send-the-heartbeat) groups all
   * reports in one SEND; the SDK groups each kind by market and waits for full depth once per kind.
   * Plan checks between batches and during the shared wait stop stale attempts. Every report must
   * still be canonical before heartbeat; the cycle ends only after the heartbeat is confirmed.
   */
  async signalAndHeartbeat(screened: Screened): Promise<Attested | Stale | NothingDue> {
    if (this.#isWriting) {
      throw new Error('another write operation is in progress');
    }
    this.#isWriting = true;
    try {
      if (this.#setup.mode === 'observe') {
        throw new GuardianStop('submission-disabled');
      }
      const work = screened.work();
      if (!this.#isHeartbeatDue(work)) {
        return nothingDue(
          {
            coverageThrough: work.coverage,
            storedTimestamp: work.storedTimestamp,
            verifiedAt: work.reportBlock,
          },
          'no-work-and-idle-heartbeat-not-due',
        );
      }

      const reported = await this.#report(screened);
      if ('kind' in reported) {
        return reported;
      }

      const staleReason = await this.#invalidation(work);
      if (staleReason !== null) {
        return { kind: 'stale', reason: staleReason };
      }
      if (!(await this.#isEveryReportConfirmed(reported))) {
        return { kind: 'stale', reason: 'report-no-longer-confirmed' };
      }

      return await this.#heartbeat(work);
    } finally {
      this.#isWriting = false;
    }
  }

  // ─── Runner recovery: shared across signing-client implementations.

  /**
   * Explicit recovery for a dedicated signer before a fresh signal cycle. This is runner policy,
   * not a scan phase: an old transaction or our cancellation must consume each pending nonce.
   */
  async clearPendingNonces(): Promise<void> {
    if (this.#setup.mode === 'observe') {
      throw new GuardianStop('submission-disabled');
    }
    if (this.#isWriting) {
      throw new Error('another write operation is in progress');
    }
    const client = this.#setup.client;
    const signer = requireDefined('client.signer', client.signer);
    const cycle = this.#activeCycle === undefined ? {} : this.#activeCycle;
    const context: TransactionContext = Object.freeze({ method: 'cancel', operationId: randomUUID(), ...cycle });
    const deadline = Date.now() + client.transactionPolicy.sendTimeoutMs;
    this.#isWriting = true;
    try {
      await this.#requireChain();
      while (true) {
        this.#requireClearingTime(deadline);
        const nonce = await this.#pendingNonce(signer);
        if (nonce === undefined) {
          return;
        }
        await this.#clearNonce(client, { signer, nonce, context, deadline });
      }
    } catch (error) {
      emitEvent(this.#setup.onEvent, { event: 'transaction.failed', context, stage: 'nonce-clearing', error });
      throw error;
    } finally {
      this.#isWriting = false;
    }
  }

  async #pendingNonce(signer: Address): Promise<number | undefined> {
    const nonce = await this.#rpc.getTransactionCount(signer, 'latest');
    const pending = await this.#rpc.getTransactionCount(signer, 'pending');
    return pending > nonce ? nonce : undefined;
  }

  async #clearNonce(
    client: RpcClient,
    recovery: {
      readonly signer: Address;
      readonly nonce: number;
      readonly context: TransactionContext;
      readonly deadline: number;
    },
  ): Promise<void> {
    const { signer, nonce, context, deadline } = recovery;
    const policy = client.transactionPolicy;
    let previous: PreparedTransaction | undefined;
    let attempt = 0;
    while (true) {
      this.#requireClearingTime(deadline);
      if ((await client.getTransactionCount(signer, 'latest')) <= nonce) {
        if (attempt >= policy.sendAttempts) {
          throw new Error('Nonce clearing exhausted sendAttempts');
        }
        attempt += 1;
        previous = await this.#prepareCancellation(client, { signer, nonce }, previous, { attempt, context });
        this.#requireClearingTime(deadline);
        await this.#broadcastCancellation(client, previous, { attempt, context });
      }
      const waitUntil = Math.min(deadline, Date.now() + policy.replacementTimeoutMs);
      const block = await this.#waitForNonce(signer, nonce, waitUntil);
      if (block !== undefined) {
        emitEvent(this.#setup.onEvent, {
          event: 'nonce.cleared',
          context,
          nonce,
          blockNumber: BigInt(block.number),
          blockHash: block.hash,
        });
        return;
      }
    }
  }

  async #prepareCancellation(
    client: RpcClient,
    target: { readonly signer: Address; readonly nonce: number },
    previous: PreparedTransaction | undefined,
    attempt: TransactionAttempt,
  ): Promise<PreparedTransaction> {
    const estimated = await client.prepareTransaction(
      {
        chainId: this.#setup.deployment.chainId,
        to: target.signer,
        nonce: target.nonce,
        value: 0n,
        data: '0x',
        gas: CANCELLATION_GAS,
      },
      attempt,
    );
    const { maxFeePerGas, replacementFeeBumpBps } = client.transactionPolicy;
    const prepared =
      previous === undefined
        ? estimated
        : {
            ...estimated,
            maxFeePerGas: replacementFee(previous.maxFeePerGas, estimated.maxFeePerGas, replacementFeeBumpBps),
            maxPriorityFeePerGas: replacementFee(
              previous.maxPriorityFeePerGas,
              estimated.maxPriorityFeePerGas,
              replacementFeeBumpBps,
            ),
          };
    if (prepared.maxFeePerGas > maxFeePerGas) {
      throw new Error('Nonce clearing replacement fee exceeds maxFeePerGas');
    }
    return prepared;
  }

  async #broadcastCancellation(
    client: RpcClient,
    transaction: PreparedTransaction,
    options: TransactionAttempt,
  ): Promise<void> {
    try {
      await client.broadcastTransaction(transaction, options);
    } catch (error) {
      if (!(error instanceof BroadcastFailure)) {
        throw error;
      }
      // The chain state decides whether an uncertain broadcast consumed the nonce or needs replacement.
      emitEvent(this.#setup.onEvent, {
        event: 'transaction.retry',
        ...options,
        nonce: transaction.nonce,
        error: error.cause,
      });
    }
  }

  async #waitForNonce(signer: Address, nonce: number, deadline: number): Promise<BlockRef | undefined> {
    while (true) {
      const head = await this.#rpc.getBlock();
      const number = head.number + 1 - this.#setup.txConfirmationBlocks;
      if (number >= 0) {
        const block = await this.#rpc.getBlock(number);
        const consumed = await this.#rpc.getTransactionCount(signer, number);
        const checked = await this.#rpc.getBlock(number);
        if (block.hash !== checked.hash) {
          throw new Error('Nonce clearing confirmation block changed');
        }
        if (consumed > nonce) {
          return block;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return undefined;
      }
      await sleep(Math.min(this.#setup.confirmationPollIntervalMs, remaining));
    }
  }

  #requireClearingTime(deadline: number): void {
    if (Date.now() >= deadline) {
      throw new Error('Nonce clearing exceeded sendTimeoutMs');
    }
  }

  // ─── Planning: where coverage stands, and how far back the window reaches.

  /**
   * What must hold before any plan: the nodes serve the configured chain, the Guardian is a member at
   * the observed block. In signal mode the signer must be the Guardian or its expected delegate,
   * and the registry must name exactly that delegate. Observe is an SDK extension: it skips signer
   * and delegate checks, keeps membership checks, and cannot submit writes.
   */
  async #requireChain(): Promise<void> {
    if ((await this.#rpc.getChainId()) !== this.#setup.deployment.chainId) {
      throw new GuardianStop('chain-id-mismatch');
    }
  }

  async #requireConfigured(at: Bytes32): Promise<void> {
    await this.#requireChain();

    const isMember = await this.#registry.isGuardian(at);
    if (!isMember) {
      throw new GuardianStop('guardian-not-member');
    }

    if (this.#setup.mode === 'observe') {
      return;
    }

    const { guardian, expectedDelegate } = this.#setup;
    const signer = this.#setup.client.signer;
    if (signer === undefined) {
      throw new GuardianStop('signer-not-authorized');
    }
    const isGuardianSigning = isAddressEqual(signer, guardian);
    const isDelegateSigning =
      !isAddressEqual(expectedDelegate, zeroAddress) && isAddressEqual(signer, expectedDelegate);
    if (!isGuardianSigning && !isDelegateSigning) {
      throw new GuardianStop('signer-not-authorized');
    }

    const delegate = await this.#registry.delegate(at);
    if (!isAddressEqual(delegate, expectedDelegate)) {
      throw new GuardianStop('delegate-mismatch');
    }
  }

  /**
   * The block a previous heartbeat covered, or null when there is none to reuse. The stored
   * timestamp alone does not name a block, so the latest `Heartbeat` must carry it and name a block
   * whose header carries it too. A `Heartbeat` whose event timestamp has since been overtaken, or
   * whose block does not carry that timestamp, names no coverage boundary and is refused.
   */
  async #coverageThrough(
    storedTimestamp: number,
    observed: BlockRef,
    hint: Cursor | undefined,
  ): Promise<BlockRef | null> {
    if (storedTimestamp === 0) {
      return null;
    }

    const searchFrom = await this.#heartbeatSearchFrom(storedTimestamp, hint);
    const latestHeartbeat = await this.#registry.latestHeartbeat(searchFrom, observed);
    if (latestHeartbeat?.timestamp !== storedTimestamp) {
      return null;
    }

    const reported = await this.#rpc.getBlock(latestHeartbeat.blockNumber);
    return reported.timestamp === storedTimestamp ? reported : null;
  }

  /**
   * The first block the search for the latest `Heartbeat` needs. A reusable heartbeat names the one
   * canonical block whose header carries the stored timestamp, and lands after that block. A hinted
   * block that is still canonical, and whose header is not later than the stored timestamp, therefore
   * lies at or before it and bounds the search. The header read here decides, never the timestamp the
   * hint carries. Without such a hint the search reaches the registry's deployment.
   */
  async #heartbeatSearchFrom(storedTimestamp: number, hint: Cursor | undefined): Promise<number> {
    const floor = this.#setup.deployment.guardianSignals.deploymentBlock;
    const hinted = hint?.coverageThrough ?? null;
    if (hinted === null) {
      return floor;
    }

    const current = await this.#rpc.getBlock(hinted.number);
    if (current.hash !== hinted.hash) {
      return floor;
    }
    return current.timestamp <= storedTimestamp ? hinted.number : floor;
  }

  /**
   * The discovery window. It reaches back one full activation lookback before the coverage
   * boundary, because an event that set a deadline still in the future at that boundary lies before
   * it, and the lot it started is this cycle's work.
   */
  async #planFrom(cursor: Cursor, reportBlock: BlockRef): Promise<Plan | NothingDue> {
    const lookbackAnchor = await this.#lookbackAnchor(reportBlock, cursor);
    if (typeof lookbackAnchor !== 'number') {
      return lookbackAnchor;
    }

    const { deploymentBlock } = this.#setup.deployment.lidoLend;
    const discoveryFromNumber = Math.max(lookbackAnchor - this.#lookbackBlocks, deploymentBlock);
    return frozenCopy({
      kind: 'plan',
      reportBlock,
      discoveryFrom: await this.#rpc.getBlock(discoveryFromNumber),
      lookbackAnchor,
      coverage: cursor.coverageThrough,
      storedTimestamp: cursor.storedTimestamp,
    });
  }

  /**
   * Where the window is measured back from: the covered block, or this Guardian's own joining when
   * it has never heartbeated. A membership event after the report block means the Guardian was not
   * yet a member then, so there is nothing for it to attest.
   */
  async #lookbackAnchor(reportBlock: BlockRef, cursor: Cursor): Promise<number | NothingDue> {
    if (cursor.coverageThrough !== null) {
      return cursor.coverageThrough.number;
    }
    const membershipBlock = await this.#registry.latestGuardianAdded(cursor.verifiedAt);
    if (membershipBlock === null) {
      throw new GuardianStop('guardian-added-event-missing');
    }
    if (membershipBlock > reportBlock.number) {
      return nothingDue(cursor, 'membership-after-report-block');
    }
    return membershipBlock;
  }

  // ─── Discovery: which positions may have delayed collateral due at the report block.

  async #candidateOf(plan: Plan, supply: SupplyLog, markets: Markets): Promise<PositionKey | null> {
    const { guardianSignals } = this.#setup.deployment;
    const controller = await markets.controllerOf(supply.marketId, plan.reportBlock.hash);
    if (controller === zeroAddress) {
      return null;
    }
    const reportsTo = await markets.registryOf(controller, plan.reportBlock.hash);
    if (!isAddressEqual(reportsTo, guardianSignals.address)) {
      return null;
    }

    const activation = await markets.activationBefore(supply, controller);
    if (activation === null) {
      return null;
    }
    const deadline = activation.position.activatingStart + activation.position.activatingDelay;
    if (deadline > plan.reportBlock.timestamp) {
      return null;
    }
    if (!this.#isCoverageRequired(plan.coverage, activation.blockNumber, deadline)) {
      return null;
    }
    return { controller: lower(controller), marketId: supply.marketId, borrower: supply.borrower };
  }

  /** Whether the previous heartbeat already covered this activation. */
  #isCoverageRequired(coverage: BlockRef | null, startedAt: number, deadline: number): boolean {
    if (coverage === null) {
      return true;
    }
    if (startedAt > coverage.number) {
      return true;
    }
    return deadline > coverage.timestamp;
  }

  async #requireBlock(block: BlockRef): Promise<void> {
    const seen = await this.#rpc.getBlock(block.number);
    if (seen.hash !== block.hash) {
      throw new GuardianStop('node-behind-the-plan');
    }
  }

  // ─── Reconstruction: which supplies still fund each candidate's activating balance.

  async #reconstructPosition(plan: Plan, position: PositionKey, markets: Markets): Promise<SupplyAnchor[]> {
    const events = markets.lifecycleBack(position, plan.reportBlock);
    const activationBlockByAnchor = new Map<string, AnchorActivation>();
    let positionAtPreviousHeartbeat: Position | null = null;
    let current = await this.#readOlderLifecycleEvent(events);
    if (current === null) {
      throw new GuardianStop('position-without-history');
    }
    if (!this.#isBaseActivationDeadlineReached(current.position, plan.reportBlock.timestamp)) {
      return [];
    }

    while (true) {
      if (plan.coverage !== null && positionAtPreviousHeartbeat === null) {
        const isAtOrBeforeCoverage = current.at.blockNumber <= BigInt(plan.coverage.number);
        if (isAtOrBeforeCoverage) {
          positionAtPreviousHeartbeat = current.position;
        }
      }

      if (current.kind === 'activating') {
        if (current.position.dust !== 0n || current.position.activating < current.amount) {
          throw new GuardianStop('position-history-broken');
        }

        const activationBlock = current.at.blockNumber;
        const directAnchor = this.#supplyAnchorFromLifecycleEvent(current, position);
        activationBlockByAnchor.set(`${directAnchor.transactionHash}:${directAnchor.logIndex}`, {
          anchor: directAnchor,
          activationBlock,
        });
        const startedFromZero = current.position.activating === current.amount;
        const pairedSupply = startedFromZero ? await markets.supplyAfter(position, current) : null;
        // At the zero boundary, amount == supplied assets proves that no older dust was absorbed.
        if (pairedSupply?.assets === current.amount) {
          break;
        }

        const previousEvent = await this.#readOlderLifecycleEvent(events);
        // credit adds the supply plus the immediately preceding dust balance. A mismatch is missing
        // or inconsistent evidence, even when the activation started from zero (Appendix C).
        if (pairedSupply !== null && current.amount !== pairedSupply.assets + (previousEvent?.position.dust ?? 0n)) {
          throw new GuardianStop('position-history-broken');
        }
        const hasAbsorbedDust = previousEvent !== null && previousEvent.position.dust > 0n;
        if (hasAbsorbedDust) {
          const dust = await this.#findDustedEvent(events, previousEvent, plan.coverage);
          positionAtPreviousHeartbeat ??= dust.positionAtPreviousHeartbeat;
          const dustAnchor = this.#supplyAnchorFromLifecycleEvent(dust.event, position);
          activationBlockByAnchor.set(`${dustAnchor.transactionHash}:${dustAnchor.logIndex}`, {
            anchor: dustAnchor,
            activationBlock,
          });
        }

        if (startedFromZero) {
          break;
        }
        current = hasAbsorbedDust ? await this.#readOlderLifecycleEvent(events) : previousEvent;
        if (current === null) {
          throw new GuardianStop('position-history-broken');
        }
        continue;
      }

      if (current.position.activating <= 0n) {
        throw new GuardianStop('position-history-broken');
      }
      current = await this.#readOlderLifecycleEvent(events);
      if (current === null) {
        throw new GuardianStop('position-history-broken');
      }
    }

    const contributors = [...activationBlockByAnchor.values()];
    const wasDueAtPreviousHeartbeat =
      plan.coverage !== null &&
      positionAtPreviousHeartbeat !== null &&
      this.#isBaseActivationDeadlineReached(positionAtPreviousHeartbeat, plan.coverage.timestamp);
    if (!wasDueAtPreviousHeartbeat) {
      return contributors.map((contributor) => contributor.anchor);
    }
    const coveredThrough = BigInt(plan.coverage.number);
    return contributors
      .filter((contributor) => contributor.activationBlock > coveredThrough)
      .map((contributor) => contributor.anchor);
  }

  async #readOlderLifecycleEvent(events: LifecycleEvents): Promise<Lifecycle | null> {
    const next = await events.next();
    return next.done === true ? null : next.value;
  }

  /** Find the dust supply absorbed by an activation and preserve a crossed coverage checkpoint. */
  async #findDustedEvent(
    events: LifecycleEvents,
    newest: Lifecycle,
    coverage: BlockRef | null,
  ): Promise<{ readonly event: Lifecycle; readonly positionAtPreviousHeartbeat: Position | null }> {
    let positionAtPreviousHeartbeat: Position | null = null;
    let current: Lifecycle | null = newest;
    while (true) {
      if (current === null || current.position.dust <= 0n) {
        throw new GuardianStop('position-history-broken');
      }
      if (coverage !== null && positionAtPreviousHeartbeat === null) {
        const isAtOrBeforeCoverage = current.at.blockNumber <= BigInt(coverage.number);
        if (isAtOrBeforeCoverage) {
          positionAtPreviousHeartbeat = current.position;
        }
      }
      if (current.kind === 'dusted') {
        if (current.position.dust !== current.amount) {
          throw new GuardianStop('position-history-broken');
        }
        return { event: current, positionAtPreviousHeartbeat };
      }
      current = await this.#readOlderLifecycleEvent(events);
    }
  }

  /** Whether the lot's base timer has elapsed by `at`. A position with no activating balance never has. */
  #isBaseActivationDeadlineReached(position: Position, at: number): boolean {
    if (position.activating <= 0n) {
      return false;
    }
    return position.activatingStart + position.activatingDelay <= at;
  }

  #supplyAnchorFromLifecycleEvent(event: Lifecycle, position: PositionKey): SupplyAnchor {
    return {
      core: this.#setup.deployment.lidoLend.address,
      blockHash: event.at.blockHash,
      transactionHash: event.at.transactionHash,
      logIndex: event.at.logIndex + 1,
      marketId: position.marketId,
      borrower: position.borrower,
    };
  }

  // ─── Screening: who is asked about, and what the answers require.

  /**
   * Separate own-flagged targets from those needing provider screening at the report block.
   * Bounded batches preserve target order; a failed read prevents screening and further batches.
   */
  async #screeningTargets(work: Work): Promise<ScreeningTargets> {
    const entries = [...work.entries()];
    const pending: PendingTarget[] = [];
    const skipped: SkippedTarget[] = [];
    const { flaggerReadConcurrency } = this.#setup;
    for (let from = 0; from < entries.length; from += flaggerReadConcurrency) {
      const batch = entries.slice(from, from + flaggerReadConcurrency);
      const flagged = await Promise.all(
        batch.map(async ([position, anchors]) => ({
          target: { marketId: position.marketId, borrower: position.borrower },
          anchors,
          flaggedBy: await this.#registry.flaggedBy(position, work.reportBlock.hash),
        })),
      );
      for (const target of flagged) {
        const hasOwnFlag = target.flaggedBy.some((flagger) => isAddressEqual(flagger, this.#setup.guardian));
        if (hasOwnFlag) {
          skipped.push(target);
          continue;
        }
        pending.push({ target: target.target, anchors: target.anchors });
      }
    }
    return { pending, skipped };
  }

  // ─── Submitting: whether a heartbeat is owed, and whether the plan still describes the chain.

  /**
   * Work always needs a heartbeat, because the heartbeat is what commits it. Without work one is
   * still owed before the first coverage and then once per idle interval, so a quiet Guardian stays
   * distinguishable from a dead one without a transaction every cycle.
   */
  #isHeartbeatDue(work: Work): boolean {
    if (work.anchors > 0 || work.storedTimestamp === 0) {
      return true;
    }

    const idle = work.reportBlock.timestamp - work.storedTimestamp;

    return idle >= this.#setup.idleHeartbeatInterval;
  }

  /** Reports are grouped by kind and market; all targets in a group share one registry call. */
  async #report(screened: Screened): Promise<readonly ReceiptRef[] | Stale> {
    const work = screened.work();
    const reports: ReceiptRef[] = [];
    const groups = [
      { kind: 'suspect', targets: screened.suspects },
      { kind: 'flag', targets: screened.flags },
    ] as const;
    for (const group of groups) {
      const landed: { context: OperationContext; receipt: ReceiptRef }[] = [];
      for (const { marketId, borrowers } of this.#batches(group.targets)) {
        const reason = await this.#invalidation(work);
        if (reason !== null) {
          return { kind: 'stale', reason };
        }
        const depth = Math.min(this.#setup.txConfirmationBlocks, this.#setup.interBatchConfirmationBlocks);
        const context = this.#startReport({ method: group.kind, marketId, accounts: borrowers });
        const receipt = await this.#registry[group.kind](marketId, borrowers, {
          confirmations: depth,
          context,
        });
        landed.push({ context, receipt });
      }
      const stale = await this.#confirmReports(
        work,
        landed.map((report) => report.receipt),
      );
      if (stale !== null) {
        return stale;
      }
      for (const { context, receipt } of landed) {
        this.#confirmed(context, receipt);
      }
      reports.push(...landed.map((report) => report.receipt));
    }
    return reports;
  }

  #batches(targets: readonly SignalTarget[]): { marketId: MarketId; borrowers: Address[] }[] {
    const byMarket = new Map<MarketId, Address[]>();
    for (const target of targets) {
      const borrowers = byMarket.get(target.marketId);
      if (borrowers === undefined) {
        byMarket.set(target.marketId, [target.borrower]);
        continue;
      }
      borrowers.push(target.borrower);
    }
    const size = this.#setup.maxSignalBatchSize;
    return [...byMarket].flatMap(([marketId, borrowers]) =>
      Array.from({ length: Math.ceil(borrowers.length / size) }, (_batch, index) => ({
        marketId,
        borrowers: borrowers.slice(index * size, (index + 1) * size),
      })),
    );
  }

  /** Wait once for the whole report kind, checking the plan while the required depth accumulates. */
  async #confirmReports(work: Work, receipts: readonly ReceiptRef[]): Promise<Stale | null> {
    if (receipts.length === 0) {
      return null;
    }
    while (true) {
      const reason = await this.#invalidation(work);
      if (reason !== null) {
        return { kind: 'stale', reason };
      }
      const head = await this.#rpc.getBlock();
      const deepEnough = receipts.every(
        (receipt) => head.number - receipt.blockNumber + 1 >= this.#setup.txConfirmationBlocks,
      );
      if (deepEnough) {
        return (await this.#isEveryReportConfirmed(receipts))
          ? null
          : { kind: 'stale', reason: 'report-no-longer-confirmed' };
      }
      await sleep(this.#setup.confirmationPollIntervalMs);
    }
  }

  /** Commit coverage only after every required report has passed the final check. */
  async #heartbeat(work: Work): Promise<Attested> {
    const depth = this.#setup.txConfirmationBlocks;
    // Appendix runCycle hashes before screening. Work is an immutable snapshot, so computing
    // here commits the same complete set, including own-flagged anchors, without a cached digest.
    const digest = coverageDigest(work.all(), this.#bounds(work));
    const context = this.#startReport({
      method: 'heartbeat',
      reportBlock: work.reportBlock,
      coverageDigest: digest,
    });
    const receipt = await this.#registry.heartbeat(work.reportBlock, digest, {
      confirmations: depth,
      context,
    });
    const heartbeat = receipt.transactionHash;
    if (!(await this.#rpc.isConfirmed(receipt, await this.#rpc.getBlock(), depth))) {
      throw new Error(`Heartbeat ${heartbeat} is no longer confirmed`);
    }
    this.#confirmed(context, receipt);
    return {
      kind: 'attested',
      cursor: {
        coverageThrough: work.reportBlock,
        storedTimestamp: work.reportBlock.timestamp,
        verifiedAt: work.reportBlock,
      },
      heartbeat,
      digest,
    };
  }

  #startReport(report: ReportContext): OperationContext {
    const cycle = this.#activeCycle === undefined ? {} : this.#activeCycle;
    const context = frozenCopy({ ...report, operationId: randomUUID(), ...cycle });
    emitEvent(this.#setup.onEvent, { event: 'report.started', context });
    return context;
  }

  #confirmed(context: OperationContext, receipt: ReceiptRef): void {
    emitEvent(this.#setup.onEvent, {
      event: 'report.confirmed',
      context,
      transactionHash: receipt.transactionHash,
      receiptStatus: 'success',
      receiptBlockHash: receipt.blockHash,
    });
  }

  /**
   * Why the plan can no longer be attested, or null while it still can. A head that is not the
   * canonical block at its own number is not a reason to replan but a broken read, and stops.
   */
  async #invalidation(work: Work): Promise<StaleReason | null> {
    const head = await this.#rpc.getBlock();
    if (head.number <= work.reportBlock.number) {
      return 'head-not-past-report-block';
    }

    const { heartbeatReserveBlocks } = this.#setup;
    if (head.number - work.reportBlock.number > BLOCKHASH_LOOKBACK - heartbeatReserveBlocks) {
      return 'report-block-aged-out';
    }

    const current = await this.#rpc.getBlock(work.reportBlock.number);
    if (current.hash !== work.reportBlock.hash) {
      return 'report-block-reorged';
    }

    const stored = await this.#registry.storedHeartbeat(head.hash);
    if (stored < work.storedTimestamp) {
      return 'stored-heartbeat-moved';
    }
    if (stored > work.reportBlock.timestamp) {
      return 'stored-heartbeat-moved';
    }

    const atHead = await this.#rpc.getBlock(head.number);
    if (atHead.hash !== head.hash) {
      throw new GuardianStop('head-not-canonical');
    }
    return null;
  }

  /** Reread every receipt immediately before committing coverage. */
  async #isEveryReportConfirmed(receipts: readonly ReceiptRef[]): Promise<boolean> {
    const head = await this.#rpc.getBlock();
    for (const receipt of receipts) {
      if (!(await this.#rpc.isConfirmed(receipt, head, this.#setup.txConfirmationBlocks))) {
        return false;
      }
    }
    return true;
  }

  #bounds(work: Work): CoverageBounds {
    const { chainId, lidoLend, guardianSignals } = this.#setup.deployment;
    return {
      chainId,
      core: lidoLend.address,
      registry: guardianSignals.address,
      guardian: this.#setup.guardian,
      previousCoverage: work.coverage?.hash ?? null,
      reportBlock: work.reportBlock.hash,
    };
  }
}

/** Validate the supported profile and numeric inputs before creating a node or starting a cycle. */
function validateSetup(setup: GuardianState): void {
  const deployment = setup.deployment;
  requireInteger('deployment.chainId', deployment.chainId, { min: 1 });
  requireInteger('deployment.slotSeconds', deployment.slotSeconds, { min: 1 });
  requireInteger('maxSignalBatchSize', setup.maxSignalBatchSize, { min: 1 });
  requireInteger('deployment.lidoLend.deploymentBlock', deployment.lidoLend.deploymentBlock, { min: 0 });
  requireInteger('deployment.guardianSignals.deploymentBlock', deployment.guardianSignals.deploymentBlock, {
    min: 0,
  });
  requireInteger('idleHeartbeatInterval', setup.idleHeartbeatInterval, { min: 1 });
  requireInteger('txConfirmationBlocks', setup.txConfirmationBlocks, { min: 1 });
  requireInteger('reportBlockLag', setup.reportBlockLag, { min: 1, max: BLOCKHASH_LOOKBACK - 1 });
  requireInteger('flaggerReadConcurrency', setup.flaggerReadConcurrency, { min: 1 });
  requireInteger('interBatchConfirmationBlocks', setup.interBatchConfirmationBlocks, { min: 1 });
  requireInteger('confirmationPollIntervalMs', setup.confirmationPollIntervalMs, { min: 1, max: 2_147_483_647 });
  requireInteger('heartbeatReserveBlocks', setup.heartbeatReserveBlocks, {
    min: 1,
    max: BLOCKHASH_LOOKBACK - setup.reportBlockLag,
  });
}

function nothingDue(cursor: Cursor, reason: NothingDueReason): NothingDue {
  return { kind: 'nothing-due', cursor, reason };
}

/** Retain validated configuration, excluding signing material even when supplied to observe mode. */
function snapshotSetup(setup: GuardianSetup): GuardianState {
  if ('activationLookbackSeconds' in setup || 'activationLookbackBlocks' in setup) {
    throw new TypeError('The activation lookback is fixed at seven days');
  }
  const {
    reportBlockLag = DEFAULT_REPORT_BLOCK_LAG,
    flaggerReadConcurrency = DEFAULT_FLAGGER_READ_CONCURRENCY,
    interBatchConfirmationBlocks = DEFAULT_INTER_BATCH_CONFIRMATION_BLOCKS,
    confirmationPollIntervalMs = setup.deployment.slotSeconds * MILLISECONDS_PER_SECOND,
  } = setup;
  const common = {
    deployment: frozenCopy(setup.deployment),
    guardian: setup.guardian,
    screening: setup.screening,
    reportBlockLag,
    flaggerReadConcurrency,
    interBatchConfirmationBlocks,
    confirmationPollIntervalMs,
    idleHeartbeatInterval: setup.idleHeartbeatInterval,
    heartbeatReserveBlocks: setup.heartbeatReserveBlocks,
    txConfirmationBlocks: setup.txConfirmationBlocks,
    maxSignalBatchSize: setup.maxSignalBatchSize,
    ...(setup.onEvent === undefined ? {} : { onEvent: setup.onEvent }),
  };
  if (setup.mode === 'observe') {
    return { ...common, mode: 'observe', client: setup.client };
  }
  requireDefined('client.signer in signal mode', setup.client.signer);
  const expectedDelegate = requireDefined('expectedDelegate in signal mode', setup.expectedDelegate);
  return { ...common, mode: 'signal', client: setup.client, expectedDelegate };
}
