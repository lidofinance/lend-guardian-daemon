// What the five phases hand back. Each value says what the cycle established and what the caller
// may do next, so the loop around them is a decision over values rather than over exceptions.

import type { DiscoveredPosition, LifecycleEventRef, PositionKey, SignalTarget, SupplyAnchor } from './types.ts';
import type { ScreeningResult } from './screening-provider.ts';
import type { Address, BlockRef, Bytes32, TxHash } from '../common/types.ts';
import { frozenCopy } from '../common/immutable.ts';
import { isRecord } from '../common/validation.ts';
import { GuardianStop } from './stop.ts';

export type NothingDueReason =
  | 'report-block-before-core-deployment'
  | 'report-block-not-past-stored-heartbeat'
  | 'membership-after-report-block'
  | 'no-work-and-idle-heartbeat-not-due';

export interface NothingDue {
  readonly kind: 'nothing-due';
  readonly previousHeartbeatBlock: BlockRef | null;
  readonly reason: NothingDueReason;
}

// Phase values are immutable snapshots for the caller to inspect. Type-only exports limit the
// public construction API; they do not authenticate a value's origin. The caller must pass the
// original values through the same Guardian's attempt in order; there is no instance/replay guard.

export interface BlockRange {
  readonly from: BlockRef;
  readonly to: BlockRef;
}

/** The scan plan defined by the specification. `kind` distinguishes it from `NothingDue`. */
export interface ScanPlan {
  readonly kind: 'plan';
  readonly previousHeartbeatBlock: BlockRef | null;
  readonly heartbeatTimestampAtStart: number;
  /**
   * This Guardian's reports recorded after this registry timestamp belong to the current coverage:
   * the block that included the previous heartbeat, or the `GuardianAdded` block of a Guardian
   * without one. Null when the stored heartbeat has no reusable block.
   */
  readonly reportsSince: number | null;
  readonly discoveryRange: BlockRange;
}

/**
 * What phase B produced: the positions that may be due at the plan's report block.
 * The private snapshots keep later reconstruction tied to the same plan and candidate set.
 */
export class Discovered {
  readonly #plan: ScanPlan;

  readonly #candidates: readonly DiscoveredPosition[];

  constructor(plan: ScanPlan, candidates: readonly DiscoveredPosition[]) {
    this.#plan = frozenCopy({
      kind: 'plan',
      previousHeartbeatBlock: plan.previousHeartbeatBlock,
      heartbeatTimestampAtStart: plan.heartbeatTimestampAtStart,
      reportsSince: plan.reportsSince,
      discoveryRange: plan.discoveryRange,
    });
    this.#candidates = frozenCopy(candidates);
    Object.freeze(this);
  }

  plan(): ScanPlan {
    return this.#plan;
  }

  all(): PositionKey[] {
    return this.#candidates.map((candidate) => candidate.position);
  }

  /** Every candidate with the newest event discovery read for it. */
  candidates(): DiscoveredPosition[] {
    return [...this.#candidates];
  }
}

/**
 * What phase C produced: every uncovered anchor that may still contribute to a due position.
 * The private snapshot keeps the digest's input stable while callers inspect separate containers.
 * This protects ownership, not instance/attempt provenance or reuse.
 */
export class Work {
  readonly reportBlock: BlockRef;

  /** The block a previous heartbeat covered, which the digest commits alongside the anchors. */
  readonly previousHeartbeatBlock: BlockRef | null;

  /** The stored heartbeat timestamp captured while the scan plan was built. */
  readonly heartbeatTimestampAtStart: number;

  /** The plan's `reportsSince`: this Guardian's reports recorded after it count for this coverage. */
  readonly reportsSince: number | null;

  readonly anchors: number;

  readonly positions: number;

  readonly #byPosition: ReadonlyMap<PositionKey, readonly SupplyAnchor[]>;

  readonly #newestEventByPosition: ReadonlyMap<PositionKey, LifecycleEventRef>;

  /** A position without an entry in `newestEventByPosition` is walked again by an attempt given this work. */
  constructor(
    plan: ScanPlan,
    byPosition: ReadonlyMap<PositionKey, readonly SupplyAnchor[]>,
    newestEventByPosition: ReadonlyMap<PositionKey, LifecycleEventRef> = new Map(),
  ) {
    this.reportBlock = frozenCopy(plan.discoveryRange.to);
    this.previousHeartbeatBlock = frozenCopy(plan.previousHeartbeatBlock);
    this.heartbeatTimestampAtStart = plan.heartbeatTimestampAtStart;
    this.reportsSince = plan.reportsSince;
    this.#byPosition = new Map(
      [...byPosition].map(([position, anchors]) => [frozenCopy(position), frozenCopy(anchors)]),
    );
    this.#newestEventByPosition = new Map(
      [...newestEventByPosition].map(([position, newestEvent]) => [frozenCopy(position), frozenCopy(newestEvent)]),
    );
    this.positions = byPosition.size;
    this.anchors = [...byPosition.values()].reduce((total, list) => total + list.length, 0);
    Object.freeze(this);
  }

  entries(): ReadonlyMap<PositionKey, readonly SupplyAnchor[]> {
    // Freezing a Map does not disable set/delete/clear; expose a separate map instead.
    return new Map(this.#byPosition);
  }

  /**
   * The newest event each position's reconstruction started from. A later attempt keeps a position's
   * anchors only when its discovery reads the same event. The digest does not commit these.
   */
  newestEvents(): ReadonlyMap<PositionKey, LifecycleEventRef> {
    return new Map(this.#newestEventByPosition);
  }

  /** Every anchor the cycle found, flag-skipped ones included: what the digest commits. */
  all(): SupplyAnchor[] {
    return [...this.#byPosition.values()].flat();
  }
}

/** One anchor sent to the provider, and what the provider answered for it. */
export interface ScreenedAnchor {
  readonly anchor: SupplyAnchor;
  readonly result: ScreeningResult;
}

/** A target withheld from the provider because this Guardian had already flagged it. */
export interface SkippedTarget {
  readonly target: SignalTarget;
  readonly anchors: readonly SupplyAnchor[];
  /** `getFlaggedBy(marketId, borrower)` pinned at the report block, which names this Guardian. */
  readonly flaggedBy: readonly Address[];
}

/** One target still to be judged, with the anchors that stand behind it. */
export interface PendingTarget {
  readonly target: SignalTarget;
  readonly anchors: readonly SupplyAnchor[];
}

/** Targets divided by whether this Guardian's own flag already resolves them. */
export interface ScreeningTargets {
  readonly pending: readonly PendingTarget[];
  readonly skipped: readonly SkippedTarget[];
}

/**
 * What the screening phase established. What was asked and what was withheld are kept apart
 * because they answer different questions: what a provider judged, and what this Guardian had
 * already decided. An anchor without a complete answer stays in `incomplete`: the reports the
 * complete answers require can be sent, the heartbeat cannot.
 */
export class Screened {
  /** Every anchor sent to the provider, in request order, with its result. */
  readonly results: readonly ScreenedAnchor[];

  readonly skipped: readonly SkippedTarget[];

  readonly suspects: readonly SignalTarget[];

  readonly flags: readonly SignalTarget[];

  /** The anchors without a complete answer, which a later attempt asks about again. */
  readonly incomplete: readonly SupplyAnchor[];

  readonly #work: Work;

  constructor(
    work: Work,
    screening: { results: readonly ScreenedAnchor[]; skipped: readonly SkippedTarget[] },
    reports: { suspects: readonly SignalTarget[]; flags: readonly SignalTarget[] },
  ) {
    this.#work = work;
    this.results = frozenCopy(screening.results);
    this.skipped = frozenCopy(screening.skipped);
    this.suspects = frozenCopy(reports.suspects);
    this.flags = frozenCopy(reports.flags);
    this.incomplete = Object.freeze(
      this.results.filter((entry) => entry.result.status === 'incomplete').map((entry) => entry.anchor),
    );
    Object.freeze(this);
  }

  /** Validate positional provider answers and derive reports from the same captured decisions. */
  static fromAnswers(work: Work, targets: ScreeningTargets, answers: readonly unknown[]): Screened {
    const anchors = targets.pending.flatMap((entry) => entry.anchors);
    const results = Screened.#screenedAnchors(anchors, answers);
    const reports = Screened.#reportTargets(targets.pending, results);
    return new Screened(work, { results, skipped: targets.skipped }, reports);
  }

  /** The work this judgement was made over: what a heartbeat after it must commit. */
  work(): Work {
    return this.#work;
  }

  /** Every requested anchor needs its own answer, complete or not, before any reports can be submitted. */
  static #screenedAnchors(anchors: readonly SupplyAnchor[], answers: readonly unknown[]): ScreenedAnchor[] {
    if (answers.length !== anchors.length) {
      throw new GuardianStop('screening-result-missing');
    }
    return anchors.map((anchor, index) => {
      const answer = answers[index];
      if (answer === undefined) {
        throw new GuardianStop('screening-result-missing');
      }
      return { anchor, result: Screened.#screeningResult(answer) };
    });
  }

  /** Read known fields once; unrelated provider fields are neither inspected nor copied. */
  static #screeningResult(answer: unknown): ScreeningResult {
    if (!isRecord(answer)) {
      throw new GuardianStop('screening-result-malformed');
    }
    const status = answer.status;
    const hasEvidence = 'evidenceReference' in answer;
    const evidenceReference = hasEvidence ? answer.evidenceReference : undefined;
    if (evidenceReference !== undefined && evidenceReference !== null) {
      if (typeof evidenceReference !== 'string' || evidenceReference.length === 0) {
        throw new GuardianStop('screening-result-malformed');
      }
    }
    const evidence = hasEvidence ? { evidenceReference } : {};
    if (status === 'incomplete') {
      return { status, ...evidence };
    }
    if (status !== 'judged') {
      throw new GuardianStop('screening-result-malformed');
    }
    const requiresSuspect = answer.requiresSuspect;
    const requiresFlag = answer.requiresFlag;
    if (typeof requiresSuspect !== 'boolean' || typeof requiresFlag !== 'boolean') {
      throw new GuardianStop('screening-result-malformed');
    }
    return { status, requiresSuspect, requiresFlag, ...evidence };
  }

  /**
   * Consume the decisions once, in work order; repeated prefix slicing would be quadratic in target
   * count. An incomplete answer requires nothing: its target may still be reported for another anchor.
   */
  static #reportTargets(pending: readonly PendingTarget[], screened: readonly ScreenedAnchor[]) {
    const decisions = screened.values();
    const suspects = new Set<SignalTarget>();
    const flags = new Set<SignalTarget>();
    for (const entry of pending) {
      for (let remaining = entry.anchors.length; remaining > 0; remaining -= 1) {
        const decision = decisions.next().value;
        if (decision === undefined) {
          throw new GuardianStop('screening-result-missing');
        }
        if (decision.result.status !== 'judged') {
          continue;
        }
        if (decision.result.requiresSuspect) {
          suspects.add(entry.target);
        }
        if (decision.result.requiresFlag) {
          flags.add(entry.target);
        }
      }
    }
    return { suspects: [...suspects], flags: [...flags] };
  }
}

/** Why a plan can no longer be attested. Every value is chain state the caller may retry against. */
export type StaleReason =
  | 'head-not-past-report-block'
  | 'report-block-reorged'
  | 'report-block-aged-out'
  | 'stored-heartbeat-moved'
  | 'report-no-longer-confirmed';

/** The heartbeat landed: the cycle's coverage now stands at the report block. */
export interface Attested {
  readonly kind: 'attested';
  /** The report block committed by this heartbeat; pass it as the next cycle's optional hint. */
  readonly previousHeartbeatBlock: BlockRef;
  readonly heartbeat: TxHash;
  readonly digest: Bytes32;
}

/** The plan no longer describes the chain. Nothing was attested, and the caller decides what next. */
export interface Stale {
  readonly kind: 'stale';
  readonly reason: StaleReason;
  /** Set by `Guardian.cycle`: the work this attempt reconstructed, which the next attempt can reuse. */
  readonly work?: Work;
}

/** A complete read-only cycle: screening finished, but observe mode submitted nothing. */
export interface Observed {
  readonly kind: 'observed';
  readonly previousHeartbeatBlock: BlockRef | null;
  readonly screened: Screened;
}

/**
 * Screening is not complete. The reports the complete answers require were sent and confirmed, or
 * observed; the heartbeat waits until a later attempt has a complete answer for every anchor.
 */
export interface Incomplete {
  readonly kind: 'incomplete';
  readonly previousHeartbeatBlock: BlockRef | null;
  /** The anchors without a complete answer, which the next attempt asks about again. */
  readonly incomplete: readonly SupplyAnchor[];
  /** Set by `Guardian.cycle`: the work this attempt reconstructed, for the next attempt's `earlierWork`. */
  readonly work?: Work;
}

/** Every expected result of one Guardian cycle; infrastructure and invariant failures throw. */
export type CycleOutcome = Attested | NothingDue | Observed | Stale | Incomplete;
