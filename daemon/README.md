# Guardian daemon

This directory is the deployable daemon: the example's Guardian and schedule, [`../example/guardian.ts`](../example/guardian.ts), with screening over HTTP in batches, JSON logs without endpoint URLs, every event posted to a receiver, and a liveness endpoint, packaged as a Docker image. Monitoring is the operator's: its receiver turns the events into its own metrics and alerts. The SDK runs from the sources of this repository.

| File                                                     | Role                                                                                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`main.ts`](main.ts)                                     | The entry point: the daemon's settings, the JSON event output with its forwarding, `/health`, and the example's Guardian and schedule with HTTP screening. |
| [`screening.ts`](screening.ts)                           | The `ScreeningProvider` that asks the operator's screening service over HTTP.                                                                              |
| [`Dockerfile`](Dockerfile), [`compose.yml`](compose.yml) | The image, and a compose file that runs it.                                                                                                                |

## Run

No image is published yet: build one from the repository root at the revision you run, and record that revision, because the configuration, the screening request and the event records follow it.

```bash
docker build -f daemon/Dockerfile -t guardian-daemon .
```

The image holds the SDK sources, the ABI fragments, `example/guardian.ts`, `example/env.ts` and `daemon/`, with viem as pinned in `daemon/package-lock.json`, at the versions the tests run against; the build leaves `daemon/.env` out. To run the image on another host, tag it for your registry and push it there.

Start in observe mode: the daemon screens and logs the reports it would send, and sends no transactions. Switch to `MODE=signal` with the delegate's `SIGNER_KEY` once the observed reports are right. Without Docker, run `node daemon/main.ts` from a checkout after `npm ci`, on Node 24 or newer. Node does not read `daemon/.env` by itself; to take the configuration from that file, run `node --env-file=daemon/.env daemon/main.ts`.

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

The daemon reads the example's [configuration](../example/README.md#configuration) and two variables of its own: `SCREENING_URL`, the screening service, HTTP or HTTPS, and the optional `EVENTS_URL`, the operator's receiver, to which every event is posted. Invalid or missing configuration ends the process with exit code 1 before any RPC request. In production, supply `SIGNER_KEY` through the orchestrator's secret store rather than a file on the host. The schedule and the recovery are the example's, as its [delivery and recovery limits](../example/README.md#delivery-and-recovery-limits) describe.

## Settings

The Guardian, schedule and delivery settings are the example's: its [Settings](../example/README.md#settings) lists them. Every setting is optional and keeps its default while unset; a set value must be a decimal integer in the setting's range, except `RPC_USER_AGENT`, which must be nonempty text that an HTTP header can carry, without line breaks or characters beyond Latin-1. The daemon keeps every default of the example but one: `SCREENING_TIMEOUT_MS` is 1210000, 20 minutes and ten seconds, so a service that answers in batches has time for a large cycle. The daemon adds these settings:

| Variable                       | Default            | Meaning                                                                                                                      |
| ------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `RPC_USER_AGENT`               | `guardian-daemon`  | The `User-Agent` of every RPC request.                                                                                       |
| `SCREENING_BATCH_SIZE`         | 1000               | Anchors in one request to the screening service.                                                                             |
| `SCREENING_CONCURRENCY`        | 1                  | Requests to the screening service open at once; raise it only for a service that handles several requests at once.           |
| `SCREENING_REQUEST_TIMEOUT_MS` | 290000             | Wait for one request's answer; at most 290000, because Node's fetch waits at most 300 seconds for response headers.          |
| `FORWARD_TIMEOUT_MS`           | 5000               | Wait for the receiver before a post is abandoned.                                                                            |
| `HEALTH_PORT`                  | 8080               | Port of `GET /health`.                                                                                                       |
| `HEALTH_WINDOW_MS`             | 600000, 10 minutes | Time without an event after which `/health` answers 503; longer than `CYCLE_INTERVAL_MS` and `SCREENING_REQUEST_TIMEOUT_MS`. |

The daemon stops asking the service ten seconds before `SCREENING_TIMEOUT_MS` runs out, so its last request ends before the SDK's wait does; the anchors not asked about by then stay incomplete until the next cycle.

## Requirements

These requirements come from measurements of a pre-release version. Later versions may change them, and they are not guarantees.

- **Resources: 2 vCPU, 4 GB of memory and 1 GB of disk.** The daemon keeps no state, so it needs no persistent volume; the disk holds the image and rotated logs. Set `NODE_OPTIONS=--max-old-space-size=3072` so that Node's heap can use three quarters of the container's memory; by default it takes about half.
- **Why this margin.** A first cycle over 1,000 to 5,000 positions peaks near 420 MB of memory and keeps at most about 1.5 CPUs busy. A receiver that answers each post in one second keeps thousands of posts open and raises the memory to about 620 MB. The daemon image measured the cycles in a container with these resources against local nodes; the receiver figure comes from a benchmark on a laptop and is indicative. Under normal conditions these resources are enough in every scenario.
- **RPC endpoints of a paid provider or your own node.** Each endpoint serves `eth_getLogs` with address and topic filters over ranges of up to `MAX_LOG_BLOCK_RANGE` blocks, back to the core's deployment block, and up to eight concurrent requests. A provider may refuse a range that holds too many logs; the daemon reads it again in halves. A first cycle sends about five log reads and one call per position, and a cycle after a heartbeat about a hundred requests. In signal mode the reports and the heartbeat must follow within about 49 minutes of the report block, so a first cycle must read all its positions well within that time. A shared provider can take seconds for a log read, most of all for one that finds nothing; with many positions, use a faster node or raise `HISTORY_READ_CONCURRENCY` within the provider's rate limit.
- **Screening service.** A request carries at most `SCREENING_BATCH_SIZE` anchors, about 0.5 KB each, and must be answered within `SCREENING_REQUEST_TIMEOUT_MS`. The service must accept up to `SCREENING_CONCURRENCY` requests at once. The daemon keeps a complete answer until the heartbeat, so it asks about an anchor again only after an `incomplete` or after a restart; the service needs no state of its own.
- **Event receiver.** It must answer each post at once; the largest event lists every anchor, about 0.45 KB each. See [Limitations](#limitations).

## HTTP interfaces

The daemon calls two services of yours and serves one endpoint. It sends requests to the configured URLs as they are, without adding a path.

| Direction                  | Request                                                     | Body                                                                                                          | Expected answer                                      | Time limit                                 |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Daemon → screening service | `POST` to `SCREENING_URL`, `Content-Type: application/json` | At most `SCREENING_BATCH_SIZE` anchors of a cycle with work, as [Screening service](#screening-service) shows | `200` with one result per anchor                     | `SCREENING_REQUEST_TIMEOUT_MS` per request |
| Daemon → event receiver    | `POST` to `EVENTS_URL`, `Content-Type: application/json`    | One event record, as [Events and liveness](#events-and-liveness) describes                                    | Any; the daemon ignores the answer                   | `FORWARD_TIMEOUT_MS`                       |
| Orchestrator → daemon      | `GET /health` on `HEALTH_PORT`                              | None                                                                                                          | `200` while the daemon works, `503` when it is stuck | —                                          |

## Screening service

For a cycle with work, the daemon posts the anchors of the cycle in requests of at most `SCREENING_BATCH_SIZE`, with up to `SCREENING_CONCURRENCY` requests open at once, one by default:

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

- `judged` carries both report decisions. `incomplete` means the service cannot decide yet: the cycle sends the reports the complete answers require and no heartbeat, and the next cycle asks again about that anchor. `evidenceReference` is optional; when present it is a nonempty, non-secret pointer to the service's evidence.
- Another status code, a result left out or out of order, an unknown shape, or no answer within `SCREENING_REQUEST_TIMEOUT_MS` leaves the anchors of that request incomplete, recorded as `screening.requestFinished` with the cause, and the other requests of the cycle go on. Requests stop ten seconds before `SCREENING_TIMEOUT_MS` runs out; the anchors not asked about wait for the next cycle. The SDK itself stops a screening that outlasts `SCREENING_TIMEOUT_MS`, a backstop behind that limit.
- The anchors of one transaction may arrive in different requests; the service answers every anchor.
- The daemon keeps the judged answers of its last screening in memory and asks only about the other anchors, so an anchor arrives again after `incomplete`, after a restart of the daemon, and in observe mode after a complete cycle, where coverage does not advance. The service needs no cache of its own; one that calls a vendor may still keep the vendor's answers, such as the payer of a transaction by `blockHash` and `transactionHash`, against those repeats. After a vendor timeout or error the anchor stays `incomplete` and is asked about again.
- A large first cycle may not fit in `SCREENING_TIMEOUT_MS`. The daemon then collects the rest over the next cycles, each cycle's reports already sent; answering `incomplete` for an anchor the service has not finished within `SCREENING_REQUEST_TIMEOUT_MS` has the same effect.

## Events and liveness

The daemon prints every SDK event as one line of JSON on standard output, except successful RPC requests, and posts every event, those included, to `EVENTS_URL` in a request of its own. A record is one JSON object whose `event` field names it. Amounts are decimal strings, an error is `{ "name", "message" }`, and every URL in any text is replaced by `[url]`, because an RPC error names its endpoint, whose path or query may hold a key.

| Event                                       | Meaning                                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle.started`                             | A cycle began.                                                                                                                                                              |
| `cycle.planned`                             | The report block and the discovery window were chosen, or nothing is due.                                                                                                   |
| `cycle.discovered`                          | The candidate positions were found.                                                                                                                                         |
| `cycle.reconstructed`                       | The work set was built: its positions and anchors.                                                                                                                          |
| `cycle.screened`                            | The screening service judged every anchor; the record lists the required suspect and flag reports.                                                                          |
| `cycle.finished`                            | The cycle ended; `outcome.kind` is `attested`, `observed`, `nothing-due`, `stale` or `incomplete`, the last with the anchors still without a complete answer.               |
| `cycle.failed`                              | The cycle failed with an `error`, for example an RPC failure or a malformed screening result.                                                                               |
| `report.started`, `report.confirmed`        | A suspect report, flag report or heartbeat was sent, and later confirmed at full depth.                                                                                     |
| `transaction.*`                             | The steps of one transaction's delivery: `preparation`, `signing`, `broadcast`, `included` (the first inclusion, not a confirmation), `replaced`, `retry` and `failed`.     |
| `nonce.cleared`                             | A pending transaction of the signer was awaited or cancelled before a signal cycle.                                                                                         |
| `rpc.requestStarted`, `rpc.requestFinished` | One RPC request, with its method and timing; `rpcIndex` is the endpoint's position in `RPC_URLS`.                                                                           |
| `rpc.answersDiffer`                         | Providers returned different logs for one read under `RPC_LOG_QUORUM`.                                                                                                      |
| `screening.requestFinished`                 | The daemon's own record: one request to the screening service, with its `anchors`, the `judged` and `incomplete` among them, and the `error` when it gave no usable answer. |
| `schedule.cycleNotStarted`                  | The daemon's own record: clearing pending nonces failed with `error`, so the cycle did not start.                                                                           |
| `schedule.restartBudgetExhausted`           | The daemon's own record: a stale plan was rebuilt `restarts` times, the last time for `reason`.                                                                             |

The fields of the SDK events are defined by `SdkEvent` in [`src/events.ts`](../src/events.ts). An error that ends the process is printed to standard error as `{"event":"daemon.failed","error":…}`, with exit code 1. The compose file rotates the log: Docker keeps at most five files of 50 MB.

`GET /health` on `HEALTH_PORT` answers 200 while the daemon has reported an event within `HEALTH_WINDOW_MS`, and 503 otherwise. A cycle reports every RPC request, and the window outlasts the pause between cycles and the wait for screening, so 503 means the process is stuck. The compose file uses it as the container's health check; Compose only marks the container unhealthy, while a Kubernetes liveness probe on the same path restarts it.

## Limitations

- **Events are sent once, without delivery guarantees.** The daemon posts every event to `EVENTS_URL` in a separate request as it happens. It ignores the answer, does not retry, queue or batch, and abandons a request that has no answer within `FORWARD_TIMEOUT_MS`. An event is lost while the receiver is down, overloaded or restarting, and when the daemon exits with requests in flight. The receiver must keep up with the daemon's rate and answer at once, for example by queueing each request before processing it. Every physical RPC request produces two events, so one cycle can send thousands.
- **Neither connection is authenticated.** The daemon sends no credentials to the screening service or the receiver, so keep both on a private network. The screening service's answers decide the reports, so reach it over HTTPS unless it runs on the same private network.
- **A stop ends the cycle where it is.** The daemon handles no signals, so stopping the container ends a cycle at once, possibly with a transaction pending. The next signal cycle clears the signer's pending nonces before it starts.

## Verification

```bash
npm run test:daemon
npm run check
```

The tests cover the screening contract, its batches and each response that leaves a request incomplete, records without URLs, event forwarding, an observe cycle over a scripted node with a scripted screening service and receiver, an RPC failure that reaches the log and the receiver without its endpoint, nonce clearing before every signal cycle, the refusal to start without a screening service or with an invalid `EVENTS_URL` or `RPC_USER_AGENT`, and that the image installs the dependency versions the tests run against. Child-process checks use an explicit synthetic environment and replace HTTP requests with a scripted node; they never use real credentials or live RPC.
