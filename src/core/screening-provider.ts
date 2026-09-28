// The screening boundary. One interface, one method: what a provider does internally, including
// whether it resolves who funded a deposit at all, is its own business.

import type { SupplyAnchor } from './types.ts';
import type { BlockRef } from '../common/types.ts';

/**
 * The [provider request](../../docs/guardian-specification.md#screening-provider): anchors and coverage block.
 * The core supplies frozen copies of the request, anchor array, each anchor and report block;
 * the provider cannot change their identity or order, including through retained references.
 */
export interface ScreeningRequest {
  readonly chainId: number;
  readonly reportBlock: BlockRef;
  readonly anchors: readonly SupplyAnchor[];
}

/**
 * What a provider concluded about one anchor. `incomplete` is a state rather than a flag beside a
 * decision, so a timed-out API cannot be confused with a clean answer: an incomplete result blocks
 * the heartbeat, a judged one does not. The two reports are separate answers, because one anchor
 * can require both. `evidenceReference` is an opaque, non-secret pointer to the provider's evidence,
 * for the Guardian's cycle record. Omission, undefined and null mean no evidence; an identifier
 * must be a nonempty string.
 */
export type ScreeningResult =
  | { readonly status: 'incomplete'; readonly evidenceReference?: string | null | undefined }
  | {
      readonly status: 'judged';
      readonly requiresSuspect: boolean;
      readonly requiresFlag: boolean;
      readonly evidenceReference?: string | null | undefined;
    };

/**
 * Results implement the [provider contract](../../docs/guardian-specification.md#screening-provider).
 * This SDK uses request order instead of the appendix's anchor-keyed map. The provider must preserve
 * that order; count/shape checks detect omissions and malformed values, not permuted valid decisions.
 */
export interface ScreeningProvider {
  /** One result per anchor, in order; the core snapshots known decision fields before validation. */
  screen(request: ScreeningRequest): Promise<readonly ScreeningResult[]>;
}
