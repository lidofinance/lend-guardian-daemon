# Guardian daemon

A deployable Guardian built on the SDK and its [reference example](../example/README.md): the example's Guardian policy and transaction delivery, a schedule of its own, screening over HTTP, JSON logs without endpoint URLs, every event posted to a receiver, and a liveness endpoint. Monitoring is the operator's: its receiver turns the events into its own metrics and alerts. The daemon runs the SDK from the sources of this repository.

| File                                                     | Role                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`main.ts`](main.ts)                                     | The daemon: configuration, the schedule of cycles, the event log and forwarding, `/health`. |
| [`screening.ts`](screening.ts)                           | The `ScreeningProvider` that asks the operator's screening service over HTTP.               |
| [`Dockerfile`](Dockerfile), [`compose.yml`](compose.yml) | The image, and a compose file that runs it.                                                 |

## Run

1. Put the configuration below into `daemon/.env`. Git and the image build ignore that file.
2. Run your screening service where the daemon can reach it, and set `SCREENING_URL`.
3. From the repository root:

```bash
docker compose -f daemon/compose.yml up --build -d
```

Start in observe mode: the daemon screens and logs the reports it would send, and sends no transactions. Switch to `MODE=signal` with the delegate's `SIGNER_KEY` once the observed reports are right. Without Docker, run `node daemon/main.ts` from a checkout after `npm ci`, on Node 24 or newer.

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

Invalid or missing configuration ends the process with exit code 1 before any RPC request. In production, supply `SIGNER_KEY` through the orchestrator's secret store rather than a file on the host. Guardian policy and transaction delivery are constants in `main.ts`, the same as the reference example's, with the limits of its [delivery settings](../example/README.md#delivery-and-recovery-limits). The schedule and the recovery are the daemon's own:

- A cycle starts every 30 slots, six minutes, from the start of the previous one, whatever its outcome; a longer cycle is followed at once.
- In signal mode every cycle first clears the signer's pending nonces: each pending transaction is awaited or cancelled, so no transaction of an earlier cycle or process blocks this one. The signer must have no other writer. When the clearing fails, the cycle does not start and the next one tries again.
- A stale plan is rebuilt at once, up to five times; then the cycle waits for the next one.
- A failed cycle keeps the heartbeat hint it started from, and the next cycle repeats it.

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
- Another status code, a result left out or out of order, an unknown shape, or no answer within 290 seconds fails the cycle, and the next cycle asks again. Node's fetch waits at most 300 seconds for a response, which bounds this timeout.
- Anchors of one transaction arrive in the same request, so the service can resolve the payer once per transaction; it still answers every anchor.
- The same anchors arrive again in later requests: after `incomplete`, after a failed cycle, and in observe mode, where coverage does not advance. A service that calls a vendor keeps the vendor's answers, such as the payer of a transaction by `blockHash` and `transactionHash` and the screening of an address, so a repeated request does not repeat the calls. It keeps only answers: after a vendor timeout or error the anchor stays `incomplete` and is asked about again.
- A large first cycle may not fit in 290 seconds. Answer `incomplete` for the anchors that are not done, keep working on them, and the next cycle collects them.

## Events and liveness

The daemon prints every SDK event as one line of JSON on standard output, except successful RPC requests, and posts every event, those included, to `EVENTS_URL` in a request of its own. A record is the SDK event (`SdkEvent` in [`src/events.ts`](../src/events.ts)) as JSON: amounts are decimal strings, an error is `{ "name", "message" }`, and every URL in any text is replaced by `[url]`, because an RPC error names its endpoint, whose path or query may hold a key. Two records of the daemon's own take the same path: `cycle-not-started` with the `error` of a failed nonce clearing, and `restart-budget-exhausted` with the `restarts` and the last stale `reason`. An error that ends the process is printed to standard error as `{"event":"daemon.failed","error":…}`, with exit code 1. The compose file rotates the log: Docker keeps at most five files of 50 MB.

`GET /health` on port 8080 answers 200 while the daemon has reported an event within the last 10 minutes, and 503 otherwise. A cycle reports every RPC request and the longest pause between cycles is six minutes, so 503 means the process is stuck. The compose file uses it as the container's health check; Compose only marks the container unhealthy, while a Kubernetes liveness probe on the same path restarts it.

## Limitations

- **Events are sent once, without delivery guarantees.** The daemon posts every event to `EVENTS_URL` in a separate request as it happens. It does not wait for the answer, retry, queue or batch, and it abandons a request that has no answer after 5 seconds. An event is lost while the receiver is down, overloaded or restarting, and when the daemon exits with requests in flight. The receiver must keep up with the daemon's rate and answer at once, for example by queueing each request before processing it. Every physical RPC request produces two events, so one cycle can send thousands.
- **Neither connection is authenticated.** The daemon sends no credentials to the screening service or the receiver, so keep both on a private network. The screening service's answers decide the reports, so reach it over HTTPS unless it runs on the same private network.
- **A stop ends the cycle where it is.** The daemon handles no signals, so stopping the container ends a cycle at once, possibly with a transaction pending. The next signal cycle clears the signer's pending nonces before it starts.

## Verification

```bash
npm run test:daemon
```

The tests cover the screening contract and each response it refuses, records without URLs, event forwarding, an observe cycle over a scripted node with a scripted screening service and receiver, an RPC failure that reaches the log and the receiver without its endpoint, nonce clearing before every signal cycle, the replan of a stale plan within its budget, and the refusal to start without a screening service.
