// The [scan cycle](../../docs/guardian-specification.md#scan-cycle) has five phases and five public
// calls. The caller supplies the scheduler and recovery strategy, subject to the agreed scan/report
// SLA and failure requirements.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAddress, isAddressEqual, zeroAddress } from 'viem';
import { Markets } from '../contracts/markets.ts';
import { GuardianSignals } from '../contracts/guardian-signals.ts';
import type { PreviousHeartbeatEvidence } from '../contracts/guardian-signals.ts';
import { BroadcastFailure, replacementFee } from '../chain/rpc.ts';
import type { PreparedTransaction, ReceiptRef, RpcClient, RpcProvider, TransactionAttempt } from '../chain/rpc.ts';
import { emitEvent } from '../events.ts';
import type { CycleContext, EventHandler, OperationContext, ReportContext, TransactionContext } from '../events.ts';
import type { SignalTarget } from './types.ts';
import { Discovered, Screened, Work } from './outcomes.ts';
import type {
  Attested,
  CycleOutcome,
  NothingDue,
  NothingDueReason,
  PendingTarget,
  ScanPlan,
  ScreeningTargets,
  SkippedTarget,
  Stale,
  StaleReason,
} from './outcomes.ts';
import { coverageDigest } from './digest.ts';
import type { CoverageBounds } from './digest.ts';
import type { ScreeningProvider } from './screening-provider.ts';
import { GuardianStop } from './stop.ts';
import { mapConcurrently } from '../common/concurrency.ts';
import { requireDefined, requireInteger } from '../common/validation.ts';
import { frozenCopy } from '../common/immutable.ts';
import type { Address, BlockRef, Bytes32, ContractDeployment, MarketId } from '../common/types.ts';

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
  /** Registry reads of the targets kept open at once, such as their flags and recorded suspects. Defaults to 8. */
  readonly readConcurrency?: number;
  /** Maximum markets or controllers read at once in discovery, or candidate positions reconstructed. Defaults to 1. */
  readonly historyReadConcurrency?: number;
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

/**
 * Signal runs the specified cycle and submits authorized registry writes. Observe is an SDK
 * extension: it checks chain and membership and screens the same work without a signer or a write.
 */
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

const DEFAULT_READ_CONCURRENCY = 8;

const DEFAULT_HISTORY_READ_CONCURRENCY = 1;

const DEFAULT_INTER_BATCH_CONFIRMATION_BLOCKS = 2;

const MILLISECONDS_PER_SECOND = 1_000;

// The supported profile follows the [fixed constants](../../docs/guardian-specification.md#fixed-constants).
const ACTIVATION_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

/** Configured defaults are resolved once; Guardian retains no signing material. */
type GuardianState = GuardianConfig &
  Required<
    Pick<
      GuardianConfig,
      | 'reportBlockLag'
      | 'readConcurrency'
      | 'historyReadConcurrency'
      | 'interBatchConfirmationBlocks'
      | 'confirmationPollIntervalMs'
    >
  > &
  (
    | { readonly mode: 'observe'; readonly client: RpcProvider }
    | {
        readonly mode: 'signal';
        readonly client: RpcClient;
        readonly expectedDelegate: Address;
        /** The client's delivery budget, which also bounds the shared report wait and nonce clearing. */
        readonly sendTimeoutMs: number;
      }
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
   * A plan that can no longer be attested once the work is reconstructed is stale before screening.
   * Pass a stale outcome's `work` as `earlierWork` to the next attempt, which reuses what it reconstructed.
   */
  async cycle(previousHeartbeatBlock?: BlockRef | null, earlierWork?: Work): Promise<CycleOutcome> {
    if (this.#activeCycle !== undefined) {
      throw new Error('another cycle is in progress');
    }
    const context = Object.freeze({ cycleId: randomUUID() });
    const startedAt = Date.now();
    this.#activeCycle = context;
    emitEvent(this.#setup.onEvent, { event: 'cycle.started', ...context, startedAt });
    try {
      const planned = await this.buildScanPlan(previousHeartbeatBlock);
      if (planned.kind === 'nothing-due') {
        const outcome = frozenCopy(planned);
        emitEvent(this.#setup.onEvent, { event: 'cycle.planned', ...context, result: outcome });
        return this.#finishCycle(context, startedAt, outcome);
      }
      const plan = planned;
      emitEvent(this.#setup.onEvent, { event: 'cycle.planned', ...context, result: plan });

      const discovered = await this.discoverCandidatePositions(plan);
      emitEvent(this.#setup.onEvent, {
        event: 'cycle.discovered',
        ...context,
        reportBlock: plan.discoveryRange.to,
        positions: discovered.all(),
      });
      const work = await this.reconstructWork(discovered, earlierWork);
      emitEvent(this.#setup.onEvent, {
        event: 'cycle.reconstructed',
        ...context,
        reportBlock: work.reportBlock,
        positions: work.positions,
        anchors: work.all(),
      });
      // An SDK safeguard with no step in the appendix: the plan check phase 5 makes before its first
      // report runs here as well, so a plan that aged out, lost its report block or its stored
      // heartbeat during reconstruction ends the attempt before screening, with the stale outcome the
      // later check would return and the work for the next attempt.
      const staleReason = await this.#planInvalidationReason(work);
      if (staleReason !== null) {
        return this.#finishCycle(context, startedAt, Object.freeze({ kind: 'stale', reason: staleReason, work }));
      }
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
          ? Object.freeze({
              kind: 'observed',
              previousHeartbeatBlock: frozenCopy(work.previousHeartbeatBlock),
              screened,
            })
          : attachWorkToStale(frozenCopy(await this.signalAndHeartbeat(screened)), work);
      return this.#finishCycle(context, startedAt, outcome);
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

  /** Report the outcome and hand it to the caller. */
  #finishCycle(context: CycleContext, startedAt: number, outcome: CycleOutcome): CycleOutcome {
    emitEvent(this.#setup.onEvent, { event: 'cycle.finished', ...context, startedAt, finishedAt: Date.now(), outcome });
    return outcome;
  }

  /**
   * Choose coverage and recover the prior heartbeat: [scan phase 1](../../docs/guardian-specification.md#scan-cycle)
   * and [Appendix A](../../docs/guardian-specification.md#a-build-the-scan-plan).
   * The optional previous heartbeat block only narrows the event search; chain evidence still
   * establishes the stored timestamp and reusable block.
   */
  async buildScanPlan(previousHeartbeatBlock?: BlockRef | null): Promise<ScanPlan | NothingDue> {
    const observationBlock = await this.#rpc.getBlock();
    await this.#requireGuardianConfiguration(observationBlock.hash);

    const previousHeartbeatEvidence = await this.#registry.recoverPreviousHeartbeat(
      observationBlock,
      previousHeartbeatBlock,
    );

    const { deploymentBlock } = this.#setup.deployment.lidoLend;
    const { reportBlockLag } = this.#setup;
    if (observationBlock.number - reportBlockLag < deploymentBlock) {
      return nothingDue(previousHeartbeatEvidence.previousHeartbeatBlock, 'report-block-before-core-deployment');
    }
    const reportBlock = await this.#rpc.getBlock(observationBlock.number - reportBlockLag);
    if (reportBlock.timestamp <= previousHeartbeatEvidence.heartbeatTimestampAtStart) {
      return nothingDue(previousHeartbeatEvidence.previousHeartbeatBlock, 'report-block-not-past-stored-heartbeat');
    }
    return this.#completeScanPlan(previousHeartbeatEvidence, observationBlock, reportBlock);
  }

  /**
   * Find the positions that may be due: [scan phase 2](../../docs/guardian-specification.md#scan-cycle)
   * and [Appendix B](../../docs/guardian-specification.md#b-discover-candidate-positions).
   */
  async discoverCandidatePositions(plan: ScanPlan): Promise<Discovered> {
    const markets = new Markets(this.#rpc, this.#setup.deployment.lidoLend);
    await this.#requireCanonicalBlock(plan.discoveryRange.to);
    const positions = await markets.discoverCandidatePositions(
      plan,
      this.#setup.deployment.guardianSignals.address,
      this.#setup.historyReadConcurrency,
    );
    await this.#requireCanonicalBlock(plan.discoveryRange.to);
    return new Discovered(plan, positions);
  }

  /**
   * Rebuild the contributing supplies: [scan phase 3](../../docs/guardian-specification.md#scan-cycle)
   * and [Appendix C](../../docs/guardian-specification.md#c-reconstruct-the-contributors).
   *
   * A position of `earlierWork`, such as a stale attempt's, keeps its anchors when that work was
   * reconstructed from the plan's previous heartbeat at a report block that is still canonical, and the
   * position's controller logged no lifecycle event for it since. That block's hash fixes the history
   * below it, and every change of a lot is such an event, so a walk would find the same anchors: the work
   * is the one a full reconstruction finds, and a retry walks only what changed.
   */
  async reconstructWork(discovered: Discovered, earlierWork?: Work): Promise<Work> {
    const plan = discovered.plan();
    const markets = new Markets(this.#rpc, this.#setup.deployment.lidoLend);
    const reusableWork =
      earlierWork !== undefined && (await this.#canReuse(earlierWork, plan)) ? earlierWork : undefined;
    const byPosition = await markets.reconstructWork(
      plan,
      discovered.all(),
      this.#setup.historyReadConcurrency,
      reusableWork,
    );
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
   * The client's `sendTimeoutMs` bounds each send and the shared wait of each report kind. When
   * the wait ends first the attempt stops with `report-confirmation-timeout`, its reports included.
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
      const reportConfirmationTimeoutMs = this.#setup.sendTimeoutMs;
      const work = screened.work();
      if (!this.#isHeartbeatDue(work)) {
        return nothingDue(work.previousHeartbeatBlock, 'no-work-and-idle-heartbeat-not-due');
      }
      // Appendix runCycle hashes before screening. Work is an immutable snapshot, so hashing here
      // commits the same set, and a malformed input stops the attempt before the first report.
      const digest = coverageDigest(work.all(), this.#coverageDigestBounds(work));

      const recorded = await this.#recordedSuspects(work, screened.suspects);
      const reported = await this.#submitRequiredSignals(screened, recorded, reportConfirmationTimeoutMs);
      if ('kind' in reported) {
        return reported;
      }

      const staleReason = await this.#planInvalidationReason(work);
      if (staleReason !== null) {
        return { kind: 'stale', reason: staleReason };
      }
      if (!(await this.#areAllReportsConfirmed(reported))) {
        return { kind: 'stale', reason: 'report-no-longer-confirmed' };
      }
      const stillRecorded = await this.#recordedSuspects(work, [...recorded.keys()]);
      if (stillRecorded.size !== recorded.size) {
        return { kind: 'stale', reason: 'report-no-longer-confirmed' };
      }

      return await this.#submitHeartbeat(work, digest);
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
    const context: TransactionContext = Object.freeze({
      method: 'cancel',
      operationId: randomUUID(),
      ...(this.#activeCycle ?? {}),
    });
    const deadline = Date.now() + this.#setup.sendTimeoutMs;
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

  async #requireChain(): Promise<void> {
    if ((await this.#rpc.getChainId()) !== this.#setup.deployment.chainId) {
      throw new GuardianStop('chain-id-mismatch');
    }
  }

  /**
   * Require the configured chain and membership at the observed block. Signal mode also requires
   * the configured signer and delegate relation; observe mode has no signer and cannot submit writes.
   */
  async #requireGuardianConfiguration(at: Bytes32): Promise<void> {
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
   * The discovery window. It reaches back one full activation lookback before the coverage
   * boundary, because an event that set a deadline still in the future at that boundary lies before
   * it, and the lot it started is this cycle's work.
   */
  async #completeScanPlan(
    previousHeartbeatEvidence: PreviousHeartbeatEvidence,
    observationBlock: BlockRef,
    reportBlock: BlockRef,
  ): Promise<ScanPlan | NothingDue> {
    const lookbackAnchorNumber = await this.#findLookbackAnchorNumber(
      previousHeartbeatEvidence.previousHeartbeatBlock,
      observationBlock,
      reportBlock,
    );
    if (typeof lookbackAnchorNumber !== 'number') {
      return lookbackAnchorNumber;
    }

    const { deploymentBlock } = this.#setup.deployment.lidoLend;
    const firstEventBlock = Math.max(lookbackAnchorNumber - this.#lookbackBlocks, deploymentBlock);
    return frozenCopy({
      kind: 'plan',
      previousHeartbeatBlock: previousHeartbeatEvidence.previousHeartbeatBlock,
      heartbeatTimestampAtStart: previousHeartbeatEvidence.heartbeatTimestampAtStart,
      reportsSince: await this.#reportsSince(previousHeartbeatEvidence, lookbackAnchorNumber),
      discoveryRange: {
        from: await this.#rpc.getBlock(firstEventBlock),
        to: reportBlock,
      },
    });
  }

  /**
   * From when this Guardian's own reports count for the current coverage: after the block that
   * included the previous heartbeat, or after joining for a Guardian without one. A stored heartbeat
   * without a reusable block leaves that unknown, so no recorded report counts.
   */
  async #reportsSince(evidence: PreviousHeartbeatEvidence, lookbackAnchorNumber: number): Promise<number | null> {
    if (evidence.previousHeartbeatBlock !== null) {
      return evidence.previousHeartbeatIncludedAt;
    }
    if (evidence.heartbeatTimestampAtStart !== 0) {
      return null;
    }
    const joined = await this.#rpc.getBlock(lookbackAnchorNumber);
    return joined.timestamp;
  }

  /**
   * Where the window is measured back from: the covered block, or this Guardian's own joining when
   * it has never heartbeated. A membership event after the report block means the Guardian was not
   * yet a member then, so there is nothing for it to attest.
   */
  async #findLookbackAnchorNumber(
    previousHeartbeatBlock: BlockRef | null,
    observationBlock: BlockRef,
    reportBlock: BlockRef,
  ): Promise<number | NothingDue> {
    if (previousHeartbeatBlock !== null) {
      return previousHeartbeatBlock.number;
    }
    const membershipBlock = await this.#registry.latestGuardianAdded(observationBlock);
    if (membershipBlock === null) {
      throw new GuardianStop('guardian-added-event-missing');
    }
    if (membershipBlock > reportBlock.number) {
      return nothingDue(previousHeartbeatBlock, 'membership-after-report-block');
    }
    return membershipBlock;
  }

  /**
   * Whether `earlierWork` was reconstructed from the plan's previous heartbeat at a report block that is
   * still canonical and not after the plan's. That block's hash commits to every block below it.
   */
  async #canReuse(earlierWork: Work, plan: ScanPlan): Promise<boolean> {
    const earlierHeartbeat = earlierWork.previousHeartbeatBlock;
    const currentHeartbeat = plan.previousHeartbeatBlock;
    const isSameCoverage =
      earlierHeartbeat === null || currentHeartbeat === null
        ? earlierHeartbeat === currentHeartbeat
        : earlierHeartbeat.hash === currentHeartbeat.hash;
    if (!isSameCoverage || earlierWork.reportBlock.number > plan.discoveryRange.to.number) {
      return false;
    }
    const seen = await this.#rpc.getBlock(earlierWork.reportBlock.number);
    return seen.hash === earlierWork.reportBlock.hash;
  }

  async #requireCanonicalBlock(block: BlockRef): Promise<void> {
    const seen = await this.#rpc.getBlock(block.number);
    if (seen.hash !== block.hash) {
      throw new GuardianStop('node-behind-the-plan');
    }
  }

  // ─── Screening: who is asked about, and what the answers require.

  /**
   * Separate own-flagged targets from those needing provider screening at the report block, in the
   * order of the work. The flagger reads run `readConcurrency` at once; a failed read prevents screening.
   */
  async #screeningTargets(work: Work): Promise<ScreeningTargets> {
    const flagged = await mapConcurrently(
      this.#setup.readConcurrency,
      [...work.entries()],
      async ([position, anchors]) => ({
        target: { marketId: position.marketId, borrower: position.borrower },
        anchors,
        flaggedBy: await this.#registry.flaggedBy(position, work.reportBlock.hash),
      }),
    );
    const pending: PendingTarget[] = [];
    const skipped: SkippedTarget[] = [];
    for (const target of flagged) {
      const hasOwnFlag = target.flaggedBy.some((flagger) => isAddressEqual(flagger, this.#setup.guardian));
      if (hasOwnFlag) {
        skipped.push(target);
        continue;
      }
      pending.push({ target: target.target, anchors: target.anchors });
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
    if (work.anchors > 0 || work.heartbeatTimestampAtStart === 0) {
      return true;
    }

    const idle = work.reportBlock.timestamp - work.heartbeatTimestampAtStart;

    return idle >= this.#setup.idleHeartbeatInterval;
  }

  /**
   * Reports are grouped by kind and market; all targets in a group share one registry call. A
   * suspect this Guardian already recorded for this coverage is kept, not sent again.
   */
  async #submitRequiredSignals(
    screened: Screened,
    recorded: ReadonlyMap<SignalTarget, number>,
    reportConfirmationTimeoutMs: number,
  ): Promise<readonly ReceiptRef[] | Stale> {
    const work = screened.work();
    const cycle = this.#activeCycle === undefined ? {} : this.#activeCycle;
    for (const [target, recordedAt] of recorded) {
      emitEvent(this.#setup.onEvent, { event: 'report.skipped', ...cycle, method: 'suspect', target, recordedAt });
    }
    const reports: ReceiptRef[] = [];
    const groups = [
      { kind: 'suspect', targets: screened.suspects.filter((target) => !recorded.has(target)) },
      { kind: 'flag', targets: screened.flags },
    ] as const;
    for (const group of groups) {
      const landed: { context: OperationContext; receipt: ReceiptRef }[] = [];
      for (const { marketId, borrowers } of this.#signalBatches(group.targets)) {
        const reason = await this.#planInvalidationReason(work);
        if (reason !== null) {
          return { kind: 'stale', reason };
        }
        const depth = Math.min(this.#setup.txConfirmationBlocks, this.#setup.interBatchConfirmationBlocks);
        const context = this.#startReportOperation({ method: group.kind, marketId, accounts: borrowers });
        const receipt = await this.#registry[group.kind](marketId, borrowers, {
          confirmations: depth,
          context,
        });
        landed.push({ context, receipt });
      }
      const stale = await this.#confirmSignalTransactions(
        work,
        landed.map((report) => report.receipt),
        reportConfirmationTimeoutMs,
      );
      if (stale !== null) {
        return stale;
      }
      for (const { context, receipt } of landed) {
        this.#emitConfirmedReport(context, receipt);
      }
      reports.push(...landed.map((report) => report.receipt));
    }
    return reports;
  }

  #signalBatches(targets: readonly SignalTarget[]): { marketId: MarketId; borrowers: Address[] }[] {
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

  /**
   * Wait once for the whole report kind, checking the plan while the required depth accumulates.
   * The deadline is an SDK safeguard: an endpoint whose head stops advancing must not hold the
   * attempt forever. The reports are included by then, so the stop leaves repeating them to the caller.
   */
  async #confirmSignalTransactions(
    work: Work,
    receipts: readonly ReceiptRef[],
    timeoutMs: number,
  ): Promise<Stale | null> {
    if (receipts.length === 0) {
      return null;
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const reason = await this.#planInvalidationReason(work);
      if (reason !== null) {
        return { kind: 'stale', reason };
      }
      const head = await this.#rpc.getBlock();
      const deepEnough = receipts.every(
        (receipt) => head.number - receipt.blockNumber + 1 >= this.#setup.txConfirmationBlocks,
      );
      if (deepEnough) {
        return (await this.#areAllReportsConfirmed(receipts))
          ? null
          : { kind: 'stale', reason: 'report-no-longer-confirmed' };
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new GuardianStop('report-confirmation-timeout');
      }
      await sleep(Math.min(this.#setup.confirmationPollIntervalMs, remainingMs));
    }
  }

  /** Commit coverage only after every required report has passed the final check. */
  async #submitHeartbeat(work: Work, digest: Bytes32): Promise<Attested> {
    const depth = this.#setup.txConfirmationBlocks;
    const context = this.#startReportOperation({
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
    this.#emitConfirmedReport(context, receipt);
    return {
      kind: 'attested',
      previousHeartbeatBlock: work.reportBlock,
      heartbeat,
      digest,
    };
  }

  #startReportOperation(report: ReportContext): OperationContext {
    const cycle = this.#activeCycle === undefined ? {} : this.#activeCycle;
    const context = frozenCopy({ ...report, operationId: randomUUID(), ...cycle });
    emitEvent(this.#setup.onEvent, { event: 'report.started', context });
    return context;
  }

  #emitConfirmedReport(context: OperationContext, receipt: ReceiptRef): void {
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
  async #planInvalidationReason(work: Work): Promise<StaleReason | null> {
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

    const currentHeartbeatTimestamp = await this.#registry.getHeartbeat(head.hash);
    if (currentHeartbeatTimestamp < work.heartbeatTimestampAtStart) {
      return 'stored-heartbeat-moved';
    }
    if (currentHeartbeatTimestamp > work.reportBlock.timestamp) {
      return 'stored-heartbeat-moved';
    }

    const atHead = await this.#rpc.getBlock(head.number);
    if (atHead.hash !== head.hash) {
      throw new GuardianStop('head-not-canonical');
    }
    return null;
  }

  /**
   * This Guardian's recorded suspects among the targets, by when they were recorded. The
   * [specification](../../docs/guardian-specification.md#scan-cycle) lets a repeated attempt keep a
   * suspect recorded since the previous heartbeat. The SDK counts one only when it was recorded after
   * the block that included that heartbeat, or after joining, has `txConfirmationBlocks`
   * confirmations and is inside `suspectWindow`, and asks again right before the heartbeat, so the
   * heartbeat never relies on a shallow or expired report. Nothing counts while `reportsSince` is unknown.
   */
  async #recordedSuspects(work: Work, targets: readonly SignalTarget[]): Promise<ReadonlyMap<SignalTarget, number>> {
    const recorded = new Map<SignalTarget, number>();
    if (work.reportsSince === null || targets.length === 0) {
      return recorded;
    }
    const head = await this.#rpc.getBlock();
    // The newest block with `txConfirmationBlocks` confirmations, or the genesis of a shorter chain.
    const confirmed = await this.#rpc.getBlock(Math.max(head.number - this.#setup.txConfirmationBlocks + 1, 0));
    const window = await this.#registry.suspectWindow(head.hash);
    const records = await mapConcurrently(this.#setup.readConcurrency, targets, async (target) => ({
      target,
      recordedAt: await this.#registry.suspectRecordedAt(target, head.hash),
    }));
    for (const { target, recordedAt } of records) {
      if (recordedAt === null || recordedAt <= work.reportsSince) {
        continue;
      }
      const isConfirmed = recordedAt <= confirmed.timestamp;
      const isInsideWindow = recordedAt + window >= head.timestamp;
      if (isConfirmed && isInsideWindow) {
        recorded.set(target, recordedAt);
      }
    }
    return recorded;
  }

  /** Reread every receipt immediately before committing coverage. */
  async #areAllReportsConfirmed(receipts: readonly ReceiptRef[]): Promise<boolean> {
    const head = await this.#rpc.getBlock();
    for (const receipt of receipts) {
      if (!(await this.#rpc.isConfirmed(receipt, head, this.#setup.txConfirmationBlocks))) {
        return false;
      }
    }
    return true;
  }

  #coverageDigestBounds(work: Work): CoverageBounds {
    const { chainId, lidoLend, guardianSignals } = this.#setup.deployment;
    return {
      chainId,
      core: lidoLend.address,
      registry: guardianSignals.address,
      guardian: this.#setup.guardian,
      previousBlockHash: work.previousHeartbeatBlock?.hash ?? null,
      reportBlockHash: work.reportBlock.hash,
    };
  }
}

/** Validate the supported profile, addresses and numeric inputs before creating a node or starting a cycle. */
function validateSetup(setup: GuardianState): void {
  const deployment = setup.deployment;
  requireAddress('guardian', setup.guardian);
  requireAddress('deployment.lidoLend.address', deployment.lidoLend.address);
  requireAddress('deployment.guardianSignals.address', deployment.guardianSignals.address);
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
  requireInteger('readConcurrency', setup.readConcurrency, { min: 1 });
  requireInteger('historyReadConcurrency', setup.historyReadConcurrency, { min: 1 });
  requireInteger('interBatchConfirmationBlocks', setup.interBatchConfirmationBlocks, { min: 1 });
  requireInteger('confirmationPollIntervalMs', setup.confirmationPollIntervalMs, { min: 1, max: 2_147_483_647 });
  requireInteger('heartbeatReserveBlocks', setup.heartbeatReserveBlocks, {
    min: 1,
    max: BLOCKHASH_LOOKBACK - setup.reportBlockLag,
  });
  if (setup.mode === 'signal') {
    requireAddress('expectedDelegate', setup.expectedDelegate);
    // SDK guard: the heartbeat needs a slot for inclusion and one per further confirmation, plus one
    // for preparation and polling. A shorter budget can time out even when every slot has a block,
    // so construction rejects it.
    const minimumSendTimeoutMs = (setup.txConfirmationBlocks + 1) * deployment.slotSeconds * MILLISECONDS_PER_SECOND;
    requireInteger('client.transactionPolicy.sendTimeoutMs', setup.sendTimeoutMs, {
      min: minimumSendTimeoutMs,
      max: 2_147_483_647,
    });
  }
}

/** A stale result carries the attempt's work to the next attempt. */
function attachWorkToStale(result: Attested | Stale | NothingDue, work: Work): Attested | Stale | NothingDue {
  return result.kind === 'stale' ? Object.freeze({ ...result, work }) : result;
}

/** viem caches its verdict by the text of a value, so only a string may reach it. */
function requireAddress(field: string, value: unknown): void {
  const isText = typeof value === 'string';
  if (!isText || !isAddress(value)) {
    throw new TypeError(`${field} must be a valid address`);
  }
}

function nothingDue(previousHeartbeatBlock: BlockRef | null, reason: NothingDueReason): NothingDue {
  return { kind: 'nothing-due', previousHeartbeatBlock, reason };
}

/** Retain validated configuration, excluding signing material even when supplied to observe mode. */
function snapshotSetup(setup: GuardianSetup): GuardianState {
  if ('activationLookbackSeconds' in setup || 'activationLookbackBlocks' in setup) {
    throw new TypeError('The activation lookback is fixed at seven days');
  }
  const {
    reportBlockLag = DEFAULT_REPORT_BLOCK_LAG,
    readConcurrency = DEFAULT_READ_CONCURRENCY,
    historyReadConcurrency = DEFAULT_HISTORY_READ_CONCURRENCY,
    interBatchConfirmationBlocks = DEFAULT_INTER_BATCH_CONFIRMATION_BLOCKS,
    confirmationPollIntervalMs = setup.deployment.slotSeconds * MILLISECONDS_PER_SECOND,
  } = setup;
  const common = {
    deployment: frozenCopy(setup.deployment),
    guardian: setup.guardian,
    screening: setup.screening,
    reportBlockLag,
    readConcurrency,
    historyReadConcurrency,
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
  const { sendTimeoutMs } = setup.client.transactionPolicy;
  return { ...common, mode: 'signal', client: setup.client, expectedDelegate, sendTimeoutMs };
}
