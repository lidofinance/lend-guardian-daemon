# Benchmark results

> **Pre-release figures.** They were measured on a pre-release version of the SDK and the daemon. Later versions, contract upgrades, chain activity and provider limits can change them; they are not guarantees.

The latest measurements of the SDK and the daemon. The benchmark suite ran on a developer laptop over synthetic nodes, with no network between the SDK and the node, so its figures are indicative. The daemon image ran in a container with the 2 CPUs and 4 GB that [the daemon guide](../daemon/README.md#requirements) requires, against local nodes. A live network adds round trips, provider limits and load. [README.md](README.md) describes the method.

## Benchmark suite

The median of five runs of the `full` preset.

| Family           | Scenario                                                              | Result                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `discovery`      | 10,000 supplies in the discovery window                               | 0.9 s of CPU, 96 RPC requests, peak 322 MB                                                                                                   |
| `reconstruction` | 5,000 positions                                                       | 1.8 s of CPU, 24,985 RPC requests, peak 303 MB                                                                                               |
| `screening`      | 10,000 anchors                                                        | 0.4 s of CPU, 10,008 RPC requests, peak 217 MB                                                                                               |
| `reports`        | 1,000 targets, each reported as suspect and flagged, in batches of 50 | attested with 41 transactions in 100 of the 246-block budget                                                                                 |
| `cycle`          | first cycle over 5,000 positions                                      | attested; 2.1 s of CPU, 29,993 RPC requests, peak 316 MB                                                                                     |
| `cycle`          | the same positions after a heartbeat, nothing due                     | 97 RPC requests                                                                                                                              |
| `liveness`       | suspect targets a first cycle reports within the budget               | 2,360 in batches of 20 with two confirmations between batches; changing one of these, 5,900 in batches of 50 and 4,700 with one confirmation |
| `transport`      | 2,000 requests, 50 at once, over loopback HTTP                        | 6.2 ms at the median, 14.3 ms at the 95th percentile                                                                                         |
| `anvil`          | observe cycle over 1,000 supplies on the pinned contracts             | 0.9 s of CPU, 3,013 HTTP attempts, peak 313 MB                                                                                               |
| `anvil`          | signal cycle over 1,000 suspect supplies                              | attested with 21 transactions in 71 blocks                                                                                                   |
| `daemon`         | observe cycle over 1,000 anchors                                      | peak 419 MB, against 320 MB for the SDK alone; screening request 502 KB; largest event 446 KB                                                |
| `daemon`         | the same cycle with a receiver that answers each post in one second   | peak 624 MB with 3,708 posts open at once                                                                                                    |

## Daemon image

A container with 2 CPUs, 4 GB of memory and a 3 GB heap on the same laptop, posting every event to a receiver. The stands that ran these cycles are not part of this repository.

Against Anvil with the pinned contracts and a history of a few hundred blocks, one run per row:

| Run                                                  | Result                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Observe cycle over 1,000 lots                        | observed in about 2 s; 3,013 RPC requests and one screening request; peak 412 MB |
| Signal cycle over the same lots, every tenth flagged | two flag transactions of 50 and the heartbeat confirmed; peak 334 MB             |
| Node's heap limit in the 4 GB container              | 3,264 MB with `--max-old-space-size=3072`; 2,240 MB without it                   |

Against a synthetic node that serves the benchmark's history, observe cycles only. Each position holds one lot that is due, and the lots are spread over the whole seven-day window, so a cycle sends about six requests per position, against three on Anvil's short history. The screening service answers at once and judges every position clean. The node answers each request at once, or after 50 ms as a remote provider would. CPU time is the container's, including a probe that reads its counters every second.

| Positions | Node's delay per request | Cycle time | CPU time   | RPC requests | Peak memory |
| --------- | ------------------------ | ---------- | ---------- | ------------ | ----------- |
| 1,000     | none                     | 3–4 s      | 4–6 s      | 6,074        | 354 MB      |
| 5,000     | none                     | about 15 s | about 18 s | 29,984       | 418 MB      |
| 1,000     | 50 ms                    | 47 s       | 12 s       | 6,074        | 324 MB      |
| 5,000     | 50 ms                    | 3.7 min    | 51 s       | 29,984       | 384 MB      |

Three cycles in a row over 5,000 positions kept the same peak, and no second of these cycles kept more than about 1.5 CPUs busy.
