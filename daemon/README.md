# Guardian daemon

A deployable Guardian built on the SDK and its [reference example](../example/): the example's Guardian policy and transaction delivery as the defaults of its settings, a schedule of its own, screening over HTTP, JSON logs without endpoint URLs, every event posted to a receiver, and a liveness endpoint. Monitoring is the operator's: its receiver turns the events into its own metrics and alerts. The daemon runs the SDK from the sources of this repository.

| File                                                     | Role                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`main.ts`](main.ts)                                     | The daemon: configuration, the schedule of cycles, the event log and forwarding, `/health`. |
| [`screening.ts`](screening.ts)                           | The `ScreeningProvider` that asks the operator's screening service over HTTP.               |
| [`Dockerfile`](Dockerfile), [`compose.yml`](compose.yml) | The image, and a compose file that runs it.                                                 |

## Run

No image is published yet: build one from the repository root at the revision you run, and record that revision, because the configuration, the screening request and the event records follow it.

```bash
docker build -f daemon/Dockerfile -t guardian-daemon .
```

The image holds the SDK sources, the ABI fragments, `example/env.ts` and `daemon/`, with viem as pinned in `daemon/package-lock.json`; the build leaves `daemon/.env` out. To run the image on another host, tag it for your registry and push it there.

Start in observe mode: the daemon screens and logs the reports it would send, and sends no transactions. Switch to `MODE=signal` with the delegate's `SIGNER_KEY` once the observed reports are right. Without Docker, run `node daemon/main.ts` from a checkout after `npm ci`, on Node 24 or newer.

### With Docker Compose

1. Put the configuration below into `daemon/.env`. Git and the image build ignore that file.
2. Run your screening service where the daemon can reach it, and set `SCREENING_URL`.
3. From the repository root, build the image and start the container:

```bash
docker compose -f daemon/compose.yml up --build -d
```

The compose file gives the container the resources of [Requirements](#requirements), restarts it when it exits, rotates its log and checks `/health`. Follow the log with `docker compose -f daemon/compose.yml logs -f`.

### In an orchestrator

Give the container what the compose file gives it:

- the [configuration](#configuration) in environment variables, with `SIGNER_KEY` from the orchestrator's secret store;
- 2 CPUs, 4 GB of memory and `NODE_OPTIONS=--max-old-space-size=3072`;
- a liveness probe on `GET /health`, at `HEALTH_PORT`, 8080 by default;
- a restart when it exits.

Run exactly one instance per delegate: no replicas, and no new container before the old one has stopped, which a Kubernetes StatefulSet with one replica ensures. The daemon keeps no state, so an upgrade only replaces the container.

## Configuration

The daemon reads these variables from the process environment.

| Variable                                                          | Meaning                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `MODE`                                                            | `observe` by default, or `signal`.                                                                                              |
| `CHAIN_ID`                                                        | `1` (mainnet, default) or `560048` (Hoodi).                                                                                     |
| `RPC_URLS`                                                        | Comma-separated HTTP(S) endpoints, in fallback order.                                                                           |
| `RPC_LOG_QUORUM`                                                  | Optional: endpoints that must return the same logs, from 2 to the number of `RPC_URLS`. Unset, one endpoint answers a log read. |
| `GUARDIAN`                                                        | Registered Guardian address.                                                                                                    |
| `LIDO_LEND`, `GUARDIAN_SIGNALS`                                   | Deployed lending core and GuardianSignals addresses.                                                                            |
| `LIDO_LEND_DEPLOYMENT_BLOCK`, `GUARDIAN_SIGNALS_DEPLOYMENT_BLOCK` | Positive deployment block numbers used as scan floors.                                                                          |
| `SIGNER_KEY`                                                      | Signal mode only: the 32-byte private key of the Guardian's delegate. The Guardian's own key is refused.                        |
| `SCREENING_URL`                                                   | The screening service, HTTP or HTTPS.                                                                                           |
| `EVENTS_URL`                                                      | Optional: the operator's receiver, to which every event is posted.                                                              |

Invalid or missing configuration ends the process with exit code 1 before any RPC request. In production, supply `SIGNER_KEY` through the orchestrator's secret store rather than a file on the host. The schedule and the recovery are the daemon's own:

- A cycle starts every `CYCLE_INTERVAL_MS` from the start of the previous one, whatever its outcome; a longer cycle is followed at once.
- In signal mode every cycle first clears the signer's pending nonces: each pending transaction is awaited or cancelled, so no transaction of an earlier cycle or process blocks this one. The signer must have no other writer. When the clearing fails, the cycle does not start and the next one tries again.
- A stale plan is rebuilt at once, up to `MAX_RESTARTS_PER_CYCLE` times; then the cycle waits for the next one.
- A failed cycle keeps the heartbeat hint it started from, and the next cycle repeats it.

### Settings

Every setting is optional and keeps its default while unset; a set value must be a decimal integer in the setting's range, except `RPC_USER_AGENT`. Guardian policy and transaction delivery default to the reference example's values, with the limits of its [delivery settings](../example/README.md#delivery-and-recovery-limits). Guardian checks the combinations when it starts, for example that `SEND_TIMEOUT_MS` covers `TRANSACTION_CONFIRMATION_BLOCKS` plus one slot.

| Variable                          | Default                | Meaning                                                                                                                                                             |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CYCLE_INTERVAL_MS`               | 360000, 30 slots       | Time from the start of one cycle to the start of the next.                                                                                                          |
| `MAX_RESTARTS_PER_CYCLE`          | 5                      | Times one cycle rebuilds a stale plan at once before it waits for the next cycle.                                                                                   |
| `REPORT_BLOCK_LAG`                | 2                      | Blocks between the head and the report block.                                                                                                                       |
| `FLAGGER_READ_CONCURRENCY`        | 8                      | `getFlaggedBy` reads at once.                                                                                                                                       |
| `HISTORY_READ_CONCURRENCY`        | 8                      | Supplies or positions read at once in discovery and reconstruction.                                                                                                 |
| `INTER_BATCH_CONFIRMATION_BLOCKS` | 1                      | Confirmations a report batch waits for before the next batch; a report that a reorg drops is sent again after the shared wait.                                      |
| `MAX_REPORT_ATTEMPTS`             | 3                      | Passes over a report kind before a report that a reorg keeps dropping makes the cycle stale.                                                                        |
| `CONFIRMATION_POLL_INTERVAL_MS`   | 12000                  | Pause between reads while confirmations are awaited.                                                                                                                |
| `MAX_SIGNAL_BATCH_SIZE`           | 50                     | Borrowers in one report transaction; 50 stay under half of the gas one transaction may use.                                                                         |
| `IDLE_HEARTBEAT_INTERVAL_SECONDS` | 43200, 12 hours        | Time after which a heartbeat is sent though nothing new is due.                                                                                                     |
| `HEARTBEAT_RESERVE_BLOCKS`        | 8                      | Blocks of the 256-block blockhash window kept for the heartbeat.                                                                                                    |
| `TRANSACTION_CONFIRMATION_BLOCKS` | 12                     | Confirmations of every report and the heartbeat.                                                                                                                    |
| `RPC_REQUEST_TIMEOUT_MS`          | 10000                  | One HTTP attempt.                                                                                                                                                   |
| `RPC_RETRY_COUNT`                 | 2                      | Retries of a failed request.                                                                                                                                        |
| `RPC_RETRY_DELAY_MS`              | 150                    | Pause before a retry.                                                                                                                                               |
| `MAX_RPC_RESPONSE_BODY_SIZE`      | 10485760, 10 MB        | Largest response the daemon reads.                                                                                                                                  |
| `MAX_LOG_BLOCK_RANGE`             | 10000                  | The most blocks one `eth_getLogs` request spans. Set it to your provider's limit: a range the provider refuses is read again in halves, one request lost each time. |
| `RPC_USER_AGENT`                  | `guardian-daemon`      | The `User-Agent` of every RPC request.                                                                                                                              |
| `SEND_TIMEOUT_MS`                 | 264000                 | Time of one transaction from preparation to confirmation.                                                                                                           |
| `REPLACEMENT_FEE_BUMP_BPS`        | 1000, 10%              | Fee increase of a replacement, in basis points.                                                                                                                     |
| `MAX_FEE_PER_GAS_WEI`             | 100000000000, 100 gwei | Fee cap.                                                                                                                                                            |
| `REPLACEMENT_TIMEOUT_MS`          | 36000                  | Wait for inclusion before a transaction is replaced at a higher fee.                                                                                                |
| `SEND_ATTEMPTS`                   | 5                      | Preparations of one transaction, replacements included.                                                                                                             |
| `GAS_HEADROOM_BPS`                | 2000, a fifth          | Gas added to the node's estimate, in basis points: a report costs more when other guardians report the same accounts first.                                         |
| `SCREENING_TIMEOUT_MS`            | 290000                 | Wait for the screening service; at most 290000, because Node's fetch waits at most 300 seconds for response headers.                                                |
| `FORWARD_TIMEOUT_MS`              | 5000                   | Wait for the receiver before a post is abandoned.                                                                                                                   |
| `HEALTH_PORT`                     | 8080                   | Port of `GET /health`.                                                                                                                                              |
| `HEALTH_WINDOW_MS`                | 600000, 10 minutes     | Time without an event after which `/health` answers 503; longer than `CYCLE_INTERVAL_MS` and `SCREENING_TIMEOUT_MS`.                                                |

## Requirements

These requirements come from measurements of a pre-release version. Later versions may change them, and they are not guarantees.

- **Resources: 2 vCPU, 4 GB of memory and 10 GB of disk.** The daemon keeps no state, so it needs no persistent volume; the disk holds the image and rotated logs. Set `NODE_OPTIONS=--max-old-space-size=3072` so that Node's heap can use three quarters of the container's memory; by default it takes about half.
- **Why this margin.** A cycle that screens 1,000 anchors peaks near 420 MB of memory. A receiver that answers each post in one second keeps thousands of posts open and raises that to about 620 MB. A first cycle over 5,000 positions spends about two seconds of CPU. The daemon image confirmed the first figure in a container with these resources against a local node; the others come from [the benchmark suite](../benchmarks/) on a laptop and are indicative, and [the benchmark results](../benchmarks/RESULTS.md) list them. Under normal conditions these resources are enough in every scenario.
- **RPC endpoints answering within about 100 ms.** Each endpoint serves `eth_getLogs` with address and topic filters over ranges of up to `MAX_LOG_BLOCK_RANGE` blocks, back to the core's deployment block, and up to eight concurrent requests. A provider may refuse a range that holds too many logs; the daemon reads it again in halves. A first cycle over 5,000 positions sends about 30,000 requests, and a cycle after a heartbeat about a hundred.
- **Screening service.** One request carries every anchor of a cycle, about 0.5 KB each, and must be answered within `SCREENING_TIMEOUT_MS`.
- **Event receiver.** It must answer each post at once; the largest event lists every anchor, about 0.45 KB each. See [Limitations](#limitations).

## HTTP interfaces

The daemon calls two services of yours and serves one endpoint. It sends requests to the configured URLs as they are, without adding a path.

| Direction                  | Request                                                     | Body                                                                                | Expected answer                                      | Time limit             |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------- |
| Daemon → screening service | `POST` to `SCREENING_URL`, `Content-Type: application/json` | Every anchor of a cycle with work, as [Screening service](#screening-service) shows | `200` with one result per anchor                     | `SCREENING_TIMEOUT_MS` |
| Daemon → event receiver    | `POST` to `EVENTS_URL`, `Content-Type: application/json`    | One event record, as [Events and liveness](#events-and-liveness) describes          | Any; the daemon ignores the answer                   | `FORWARD_TIMEOUT_MS`   |
| Orchestrator → daemon      | `GET /health` on `HEALTH_PORT`                              | None                                                                                | `200` while the daemon works, `503` when it is stuck | —                      |

## Screening service

For a cycle with work, the daemon posts every anchor of the cycle in one request:

```json
{
  "chainId": 1,
  "reportBlock": { "number": 21000000, "hash": "0x…", "timestamp": 1730000000 },
  "anchors": [
    {
      "id": "<blockHash>:<transactionHash>:<logIndex>",
      "core": "0x…",
      "blockHash": "0x…",
      "transactionHash": "0x…",
      "logIndex": 5,
      "marketId": "0x…",
      "borrower": "0x…"
    }
  ]
}
```

The service answers with status 200 and one result per anchor, in request order, each repeating the anchor's `id`:

```json
{
  "results": [
    { "id": "…", "status": "judged", "requiresSuspect": false, "requiresFlag": true, "evidenceReference": "case-17" },
    { "id": "…", "status": "incomplete" }
  ]
}
```

- `judged` carries both report decisions. `incomplete` means the service cannot decide yet: the cycle stops before any report, and the next cycle asks again. `evidenceReference` is optional; when present it is a nonempty, non-secret pointer to the service's evidence.
- Another status code, a result left out or out of order, an unknown shape, or no answer within `SCREENING_TIMEOUT_MS` fails the cycle, and the next cycle asks again.
- Anchors of one transaction arrive in the same request, so the service can resolve the payer once per transaction; it still answers every anchor.
- The same anchors arrive again in later requests: after `incomplete`, after a failed cycle, and in observe mode, where coverage does not advance. A service that calls a vendor keeps the vendor's answers, such as the payer of a transaction by `blockHash` and `transactionHash` and the screening of an address, so a repeated request does not repeat the calls. It keeps only answers: after a vendor timeout or error the anchor stays `incomplete` and is asked about again.
- A large first cycle may not fit in `SCREENING_TIMEOUT_MS`. Answer `incomplete` for the anchors that are not done, keep working on them, and the next cycle collects them.

## Events and liveness

The daemon prints every SDK event as one line of JSON on standard output, except successful RPC requests, and posts every event, those included, to `EVENTS_URL` in a request of its own. A record is one JSON object whose `event` field names it. Amounts are decimal strings, an error is `{ "name", "message" }`, and every URL in any text is replaced by `[url]`, because an RPC error names its endpoint, whose path or query may hold a key.

| Event                                       | Meaning                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle.started`                             | A cycle began.                                                                                                                                                          |
| `cycle.planned`                             | The report block and the discovery window were chosen, or nothing is due.                                                                                               |
| `cycle.discovered`                          | The candidate positions were found.                                                                                                                                     |
| `cycle.reconstructed`                       | The work set was built: its positions and anchors.                                                                                                                      |
| `cycle.screened`                            | The screening service judged every anchor; the record lists the required suspect and flag reports.                                                                      |
| `cycle.finished`                            | The cycle ended; `outcome.kind` is `attested`, `observed`, `nothing-due` or `stale`.                                                                                    |
| `cycle.failed`                              | The cycle failed with an `error`, for example an RPC failure or an `incomplete` screening result.                                                                       |
| `report.started`, `report.confirmed`        | A suspect report, flag report or heartbeat was sent, and later confirmed at full depth.                                                                                 |
| `transaction.*`                             | The steps of one transaction's delivery: `preparation`, `signing`, `broadcast`, `included` (the first inclusion, not a confirmation), `replaced`, `retry` and `failed`. |
| `nonce.cleared`                             | A pending transaction of the signer was awaited or cancelled before a signal cycle.                                                                                     |
| `rpc.requestStarted`, `rpc.requestFinished` | One RPC request, with its method and timing; `rpcIndex` is the endpoint's position in `RPC_URLS`.                                                                       |
| `rpc.answersDiffer`                         | Providers returned different logs for one read under `RPC_LOG_QUORUM`.                                                                                                  |
| `cycle-not-started`                         | The daemon's own record: clearing pending nonces failed with `error`, so the cycle did not start.                                                                       |
| `restart-budget-exhausted`                  | The daemon's own record: a stale plan was rebuilt `restarts` times, the last time for `reason`.                                                                         |

The fields of the SDK events are defined by `SdkEvent` in [`src/events.ts`](../src/events.ts). An error that ends the process is printed to standard error as `{"event":"daemon.failed","error":…}`, with exit code 1. The compose file rotates the log: Docker keeps at most five files of 50 MB.

`GET /health` on `HEALTH_PORT` answers 200 while the daemon has reported an event within `HEALTH_WINDOW_MS`, and 503 otherwise. A cycle reports every RPC request, and the window outlasts the pause between cycles and the wait for screening, so 503 means the process is stuck. The compose file uses it as the container's health check; Compose only marks the container unhealthy, while a Kubernetes liveness probe on the same path restarts it.

## Limitations

- **Events are sent once, without delivery guarantees.** The daemon posts every event to `EVENTS_URL` in a separate request as it happens. It ignores the answer, does not retry, queue or batch, and abandons a request that has no answer within `FORWARD_TIMEOUT_MS`. An event is lost while the receiver is down, overloaded or restarting, and when the daemon exits with requests in flight. The receiver must keep up with the daemon's rate and answer at once, for example by queueing each request before processing it. Every physical RPC request produces two events, so one cycle can send thousands.
- **Neither connection is authenticated.** The daemon sends no credentials to the screening service or the receiver, so keep both on a private network. The screening service's answers decide the reports, so reach it over HTTPS unless it runs on the same private network.
- **A stop ends the cycle where it is.** The daemon handles no signals, so stopping the container ends a cycle at once, possibly with a transaction pending. The next signal cycle clears the signer's pending nonces before it starts.

## Verification

```bash
npm run test:daemon
```

The tests cover the screening contract and each response it refuses, records without URLs, event forwarding, an observe cycle over a scripted node with a scripted screening service and receiver, an RPC failure that reaches the log and the receiver without its endpoint, nonce clearing before every signal cycle, the replan of a stale plan within its budget, and the refusal to start without a screening service.
