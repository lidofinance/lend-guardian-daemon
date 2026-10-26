# Guardian monitoring contract

This service observes one Guardian SDK daemon through its HTTP events. It does not establish screening correctness or canonical confirmation independently. Operational records and monitoring remain outside the [Guardian specification](https://github.com/lidofinance/lido-lend-guardian-daemon-sdk/blob/bad54c58a110a4dc2b85b9f5ac0a8541a34a7c80/docs/guardian-specification.md).

## Event boundary

The HTTP contract follows SDK daemon PR #7 at revision [`bad54c58a110a4dc2b85b9f5ac0a8541a34a7c80`](https://github.com/lidofinance/lido-lend-guardian-daemon-sdk/blob/bad54c58a110a4dc2b85b9f5ac0a8541a34a7c80/daemon/README.md#events-and-liveness). PR #5 and #6 events use the same boundary. `POST /events` accepts one JSON object with `Content-Type: application/json`.

Accepted event families are `cycle.*`, `report.started`, `report.confirmed`, `report.skipped`, `transaction.*`, `nonce.checked`, `nonce.cleared`, `rpc.requestStarted`, `rpc.requestFinished`, `rpc.answersDiffer`, `cycle-not-started`, `restart-budget-exhausted` and `daemon.failed`, limited to the names and field validators in [events.ts](events.ts). Unknown names, malformed required fields and reversed timing intervals return 400. An unsupported content type returns 415, a body exceeding 8 MiB returns 413, and a method other than POST returns 405. Accepted events return 204 after synchronous recording and metric updates.

Source event timestamps may contain fractional milliseconds. The receiver preserves source `cycleId` and operation correlation regardless of HTTP arrival order. Each SDK `Guardian.cycle()` invocation is counted separately; stale attempts are not combined into a scheduled-cycle envelope. HTTP delivery has no source-wide sequence or run identity. Multiple SDK instances must use separate receiver instances.

SDK outcome `attested` maps to metric outcome `complete`; `observed`, `nothing-due` and `stale` map to `observed`, `no-change` and `stale`. `cycle.failed` maps to `failed`. A stale result is not counted as successful coverage. A receipt inclusion is distinct from `report.confirmed`, which is the source's claim of full-depth canonical confirmation.

## Records

Records are JSON lines on stdout, with `schemaVersion`, receiver `runId`, receiver `sequence`, timestamp, level, event and details. Received records carry `source: sdk` and the SDK cycle id when supplied. Transaction details retain operation ids, method, attempts, transaction hashes and receipt evidence. Cycle details retain the report/heartbeat evidence, work anchors, screened results, skipped targets, outcome and reason available in the event. Individual screening results also produce `risk-decision` or `screening-result` records. A complete no-action result describes completed checks, not a safety verdict.

Received records retain the SDK event name. `report.confirmed`, `report.skipped`, `nonce.checked` and `nonce.cleared` remain separate record names.

Only known top-level event fields are recorded. HTTP(S) URLs are replaced with `[url]`; credential-named nested fields are removed, and error messages are bounded to 500 characters. RPC parameters are not recorded. Invalid request bodies and raw processing errors are never included in responses or diagnostics. Evidence references must be non-secret pointers supplied by the screening service.

Cycle completion timestamps come from the SDK. Events without a source timestamp receive the receiver's ingestion time; it is not their exact occurrence time. Late cycle completions increment counters but cannot move each outcome's latest completion timestamp backwards. The duration follows the latest completed cycle. Report-block gauges follow the latest received attested completion by source finish time, even when a newer failed cycle arrived first. Older attestations and later cycles without coverage do not overwrite those gauges. `monitor-started` identifies the monitoring build and non-secret configuration. `monitor-failed` records a fatal startup error. The SDK wire contract supplies no startup build/configuration record, so operators retain the SDK image digest and deployment settings separately.

Stdout is the record sink, not durable storage. Container log collection and retention belong to the operator. Synchronous sink failures are counted and return HTTP 500; 204 is not a promise of durable persistence or successful downstream retention.

## Metrics

Prometheus reads `GET /metrics`. This endpoint serves the application registry followed by default process and Node.js metrics. Runtime measurements belong to the monitoring process, not the SDK daemon. Runtime collection failure does not hide application metrics; application collection failure returns 500 with an empty body.

Existing Guardian observation metric names retain the `lido_lend_guardian_daemon_` prefix. Receiver-specific metrics use `lido_lend_guardian_monitor_`.

Transaction counters use phase names. `report.confirmed` and `nonce.cleared` use the `action-confirmed` label; `report.skipped`, a suspect this Guardian recorded since the previous heartbeat and did not send again, uses `skipped`.

| Metric                                                                                                                                             | Source and meaning                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `lido_lend_guardian_monitor_build_info`                                                                                                            | Monitoring image name, environment, version, branch and commit. Value 1.                                   |
| `lido_lend_guardian_monitor_last_event_timestamp_seconds`                                                                                          | Ingestion time of the last accepted event; absent before the first event.                                  |
| `lido_lend_guardian_monitor_events_total{event}`                                                                                                   | Accepted events, with event names from the closed SDK contract.                                            |
| `lido_lend_guardian_monitor_failures_total{reason}`                                                                                                | Rejections and processing failures: `body`, `schema`, `content-type`, `record`.                            |
| `lido_lend_guardian_daemon_cycles_total{outcome}`                                                                                                  | SDK cycle invocations ending as `complete`, `observed`, `no-change`, `stale` or `failed`.                  |
| `lido_lend_guardian_daemon_last_cycle_timestamp_seconds{outcome}`                                                                                  | Latest source completion time for each outcome; older observations cannot decrease it.                     |
| `lido_lend_guardian_daemon_last_cycle_duration_seconds`                                                                                            | Source finish minus start for the latest seen completion.                                                  |
| `lido_lend_guardian_daemon_report_block_number`, `lido_lend_guardian_daemon_report_block_timestamp_seconds`                                        | Report block from the latest received attested completion by source finish time.                           |
| `lido_lend_guardian_daemon_transactions_total{event,method}`                                                                                       | Preparation, signing, broadcast, inclusion, replacement, retry, failure and confirmed-report observations. |
| `lido_lend_guardian_daemon_transaction_preparation_duration_seconds`, `lido_lend_guardian_daemon_transaction_signing_duration_seconds`             | SDK-provided phase intervals.                                                                              |
| `lido_lend_guardian_daemon_transaction_inclusion_duration_seconds`                                                                                 | SDK-provided inclusion duration; not full confirmation.                                                    |
| `lido_lend_guardian_daemon_anchors_screened_total`                                                                                                 | Per-anchor results in `cycle.screened`.                                                                    |
| `lido_lend_guardian_daemon_risk_decisions_total{action}`                                                                                           | Required suspect and flag decisions.                                                                       |
| `lido_lend_guardian_daemon_log_records_total{level}`                                                                                               | Emitted application records.                                                                               |
| `http_rpc_requests_total`, `http_rpc_batch_size`, `http_rpc_response_seconds`, `http_rpc_request_payload_bytes`, `http_rpc_response_payload_bytes` | HTTP status, bytes and elapsed time supplied by `rpc.requestFinished`.                                     |
| `rpc_request_total`                                                                                                                                | RPC call outcomes supplied by `rpc.requestFinished`.                                                       |

RPC labels include `network=ethereum`, `layer=el` and `provider=rpc-N` for source endpoint indexes 0 through 63. Larger indexes use the bounded `rpc-other` label. Original indexes remain in records. Chain ID, Guardian address and SDK mode are not monitoring configuration or Prometheus labels. RPC methods and transaction methods are validated closed sets. Cycle ids, operation ids, anchors, transaction hashes, URLs and credentials are never Prometheus labels.

The SDK serializer retains error name/message but not viem's code and cause structure. Consequently `rpc_error_code` is empty for received events. HTTP success and RPC success are counted separately: an HTTP 200 event carrying an error is a failed RPC call. The wire contract does not distinguish every HTTP-body and RPC-schema failure. Full confirmation latency is unavailable because `report.confirmed` carries no source timestamp; the receiver does not infer it from network arrival times.

The HTTP receiver does not synthesize SDK build identity, confirmed restarts, screening HTTP request samples or vendor failures from events that do not supply them. Screening/provider monitoring belongs to the screening service's own `/metrics`.

## Health, delivery and alerts

`GET /health` returns 200 while the receiver can serve requests. `GET /ready` returns 200 when at least one valid event has arrived and its ingestion time is within `MONITOR_PROGRESS_TIMEOUT_SECONDS`; otherwise 503. Both return the monitoring version and the last accepted event time. A failed SDK cycle can still refresh source liveness; freshness does not prove successful screening or a confirmed heartbeat.

SDK daemon delivery is best effort: each event is posted once, response status is ignored, and requests time out or can be interrupted by process exit. Events may arrive out of order or be lost. There is no acknowledgement/retry protocol or replay log. Receiver freshness can detect silence; it cannot prove a complete stream. Counters represent received observations and reset with the receiver process. The receiver does not add speculative deduplication without an event identity contract.

Alert on receiver availability, source silence, cycle failures, exhausted replan budgets and stalled confirmed progress using the accepted events and metrics. Monitor the onchain heartbeat independently of both processes under the agreed SLA. No onchain watcher or alert delivery runs in this service.

Operators retain incident records for the agreed period, including SDK deployment identity, cycle start/end and stopping phase, work-set evidence and skipped `getFlaggedBy` results, per-anchor decisions and evidence references, report/heartbeat transactions and canonical receipt evidence. The SDK event stream provides the available execution evidence; its best-effort transport and absent startup metadata do not establish complete record retention. Retracting a Guardian report and lifting a ban remain distinct onchain operations; monitoring has no governance or signing authority.
