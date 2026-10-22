// The specification's `REQUIRE`: the attempt cannot continue, and no heartbeat is sent. It is an
// exception rather than a returned value because it can arise several calls deep, and the phases
// read better without threading a failure through every step. The reason is a closed set so the
// caller can decide from it what to do next.

/** Why the attempt stopped: a missing requirement or an SDK mode restriction. */
export type StopReason =
  /** An observe-only Guardian was asked to submit reports or a heartbeat. */
  | 'submission-disabled'
  /** The node serves another chain than the deployment names. */
  | 'chain-id-mismatch'
  | 'guardian-not-member'
  /** The configured signer is neither the Guardian nor its expected delegate. */
  | 'signer-not-authorized'
  /** The registry names another delegate for the Guardian than the expected one, none included. */
  | 'delegate-mismatch'
  | 'guardian-added-event-missing'
  /** The log before a supply was not its controller's classification of that supply. */
  | 'supply-without-controller-event'
  /** An endpoint no longer holds the block the plan was built on. */
  | 'node-behind-the-plan'
  /** A log a query returned does not decode as the event it was selected for. */
  | 'log-undecodable'
  /** The head a submission is measured from is not the block the nodes hold at its number. */
  | 'head-not-canonical'
  /** A log a walk read sits in a block that is not the canonical block at its number: a branch the chain does not hold. */
  | 'log-not-canonical'
  /** A walk found no controller event for a candidate position, as a lagging endpoint answers. */
  | 'position-without-history'
  /** The controller's events for a position do not compose into the position they record. */
  | 'position-history-broken'
  /** The provider answered in a shape the cycle cannot act on: a status nobody defined, a report left out. */
  | 'screening-result-malformed'
  /** The provider answered for a different number of anchors than it was asked about. */
  | 'screening-result-missing'
  /** Required report receipts did not reach the configured depth inside the client's delivery budget. */
  | 'report-confirmation-timeout'
  /** A report receipt names a transaction that is not the report this Guardian's signer sent to the registry in this attempt. */
  | 'report-receipt-foreign';

export class GuardianStop extends Error {
  readonly reason: StopReason;

  constructor(reason: StopReason) {
    super(reason);
    this.name = 'GuardianStop';
    this.reason = reason;
  }
}
