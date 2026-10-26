# Guardian monitoring receiver

The daemon posts every SDK event to `EVENTS_URL` ([daemon/README.md](../daemon/README.md), Events and liveness). This receiver takes them on `POST /events`, keeps Prometheus metrics under the names of the previous Guardian daemon, prints each non-routine event as a JSON record with a level, and answers readiness from the daemon's progress. It runs beside the daemon as its own container from its own image.

| File                         | Role                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`main.ts`](main.ts)         | Configuration, build info, the server.                                                                               |
| [`events.ts`](events.ts)     | The event names and their levels, bound to `SdkEvent` of [`src/events.ts`](../src/events.ts); parsing and scrubbing. |
| [`receiver.ts`](receiver.ts) | What each event updates, the printed record and the freshness state.                                                 |
| [`metrics.ts`](metrics.ts)   | The registry.                                                                                                        |
| [`server.ts`](server.ts)     | `/events`, `/metrics`, `/health`, `/ready`.                                                                          |
| [`Dockerfile`](Dockerfile)   | The image, built from the repository root.                                                                           |

## Run

```bash
docker build -f monitoring/Dockerfile -t guardian-monitoring .
docker run --rm -p 9464:9464 -e GUARDIAN=0x… -e MODE=signal -e CHAIN_ID=560048 guardian-monitoring
```

Or without an image, from the repository root: `node monitoring/main.ts`. The receiver has no dependency on the daemon's code at run time; `monitoring/package.json` lists its only runtime dependency.

## Configuration

| Variable                        | Default | Meaning                                                                                     |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `MONITOR_PORT`                  | `9464`  | The port of every endpoint.                                                                 |
| `MONITOR_EVENT_TIMEOUT_SECONDS` | `900`   | `/ready` is 503 after this long without an accepted event.                                  |
| `MONITOR_CYCLE_TIMEOUT_SECONDS` | `3600`  | `/ready` is 503 after this long without a finished or failed cycle.                         |
| `GUARDIAN`, `MODE`, `CHAIN_ID`  | empty   | The daemon's identity as the pod configures it; labels of `lido_lend_guardian_daemon_info`. |

The daemon pauses six minutes between cycles and reports every RPC request during one, so the event window outlasts the pause; a cycle with screening and a full send budget ends within the hour, so the cycle window outlasts a cycle. A daemon that keeps making RPC requests inside a cycle that never ends trips the cycle window, which event silence alone would not show.

## Endpoints

| Endpoint       | Answer                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /events` | One JSON object per request, `Content-Type: application/json`, at most 8 MiB. 204 when accepted; 400 for a body that is not JSON, not an object or names an unknown event; 405, 413, 415 otherwise.                            |
| `GET /metrics` | The Prometheus exposition.                                                                                                                                                                                                     |
| `GET /health`  | 200 while the receiver serves; the liveness probe.                                                                                                                                                                             |
| `GET /ready`   | 200 while the daemon is fresh: an event within the event window and a cycle end within the cycle window; 503 before the first cycle end and after either window lapses. Both probes return the version and the two timestamps. |

An accepted event is counted, its metrics are updated, and the record is printed before the response. A payload field that is missing or malformed skips the metric it feeds; the event still counts. The receiver does not retry, queue or acknowledge: the daemon posts once and moves on, so a lost event is invisible here; `lido_lend_guardian_monitor_last_event_timestamp_seconds` shows silence.

## Records

One JSON line on standard output per accepted event, except `rpc.requestStarted` and a successful `rpc.requestFinished`, which are thousands per cycle and are counted only: `timestamp`, `sequence` (the receiver's own counter), `level`, `event`, `cycleId` when the event has one, and `details`, the payload without `event`, `cycleId`, `params` and any field whose name looks like a credential; URLs in text are replaced by `[url]` and strings are bounded to 500 characters. Levels: `cycle.failed`, `transaction.failed`, `cycle-not-started`, `restart-budget-exhausted` and `daemon.failed` are `error`; `transaction.replaced`, `transaction.retry`, `nonce.cleared` and `rpc.answersDiffer` are `warn`; the rest is `info`.

## Metrics

`lido_lend_guardian_daemon_` is what the dashboard reads; outcomes map `attested` to `complete` and `nothing-due` to `no-change`.

| Metric                                                                                                                                           | Source                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `info{mode,guardian,chain_id}`                                                                                                                   | The configuration above, not the stream.                                                                                                                                                                                                                                                                                                                                 |
| `cycles_total{outcome}`, `last_cycle_timestamp_seconds{outcome}`, `last_cycle_duration_seconds`, `cycle_duration_seconds`                        | `cycle.finished` (`complete`, `observed`, `no-change`, `stale`), `cycle.failed` (`failed`).                                                                                                                                                                                                                                                                              |
| `report_block_number`, `report_block_timestamp_seconds`                                                                                          | The attested block of a complete cycle; the report block of an observed cycle, remembered from its `cycle.reconstructed`.                                                                                                                                                                                                                                                |
| `cycle_restarts_total{reason}`, `restart_budget_exhausted_total`, `cycles_not_started_total`                                                     | A stale `cycle.finished`; `restart-budget-exhausted`; `cycle-not-started`.                                                                                                                                                                                                                                                                                               |
| `transactions_total{event,method}`                                                                                                               | `transaction.*` by stage, `report.confirmed` as `confirmed`, `report.skipped` as `skipped`, `nonce.cleared` as `nonce-cleared`; `method` is the report's contract method or `cancel`.                                                                                                                                                                                    |
| `transaction_inclusion_duration_seconds{method}`                                                                                                 | `transaction.included`: first broadcast to first inclusion, not a confirmation.                                                                                                                                                                                                                                                                                          |
| `anchors_screened_total{result}`, `risk_decisions_total{action}`, `screening_skipped_targets_total`                                              | `cycle.screened`: one per anchor by `none`, `suspect`, `flag`, `incomplete`; the required actions; the withheld targets.                                                                                                                                                                                                                                                 |
| `log_records_total{level}`                                                                                                                       | Every accepted event by its level.                                                                                                                                                                                                                                                                                                                                       |
| `rpc_answers_differ_total`                                                                                                                       | `rpc.answersDiffer`.                                                                                                                                                                                                                                                                                                                                                     |
| `http_rpc_requests_total`, `http_rpc_response_seconds`, `http_rpc_request_payload_bytes`, `http_rpc_response_payload_bytes`, `rpc_request_total` | `rpc.requestFinished`, with the labels of the Lido RPC metrics policy: `network=ethereum`, `layer=el`, `chain_id` from the configuration, `provider=rpc-<index in RPC_URLS>` (`rpc-other` past 63), `batched=false`, `response_code` as a class, `result`, `method` from a closed set (`other` otherwise), `rpc_error_code` from `error.code` when the daemon sends one. |

`lido_lend_guardian_monitor_build_info{version,branch,commit}`, `_events_total{event}`, `_rejected_events_total{reason}`, `_last_event_timestamp_seconds`, `_last_cycle_end_timestamp_seconds` and `_ready` describe the receiver itself; the Prometheus client's default process and Node.js metrics are the receiver's process, not the daemon's.

## Limits

The stream has no identity record, so version, commit, signer and effective settings of the daemon are not here; the running image and its digest are in `kube_pod_container_info`. The daemon serializes an error as name and message, so `rpc_error_code` stays empty until it adds a code. Counters reset with the receiver process.
