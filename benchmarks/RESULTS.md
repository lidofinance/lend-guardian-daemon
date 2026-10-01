# Benchmark results

> **Pre-release figures.** They were measured on a pre-release version of the SDK and the daemon. Later versions, contract upgrades, chain activity and provider limits can change them; they are not guarantees.

The latest measurements of the SDK and the daemon. The benchmark suite ran on a developer laptop over synthetic nodes, with no network between the SDK and the node, so its figures are indicative. The daemon image ran in a container with the 2 CPUs and 4 GB that [the daemon guide](../daemon/README.md#requirements) requires, against a local node. A live network adds round trips, provider limits and load. [README.md](README.md) describes the method.

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

A container with 2 CPUs, 4 GB of memory and a 3 GB heap, one run per row, against Anvil on the same laptop. The stand that ran these cycles is not part of this repository.

| Run                                                  | Result                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Observe cycle over 1,000 lots                        | observed in about 2 s; 3,013 RPC requests and one screening request; peak 412 MB |
| Signal cycle over the same lots, every tenth flagged | two flag transactions of 50 and the heartbeat confirmed; peak 334 MB             |
| Node's heap limit in the 4 GB container              | 3,264 MB with `--max-old-space-size=3072`; 2,240 MB without it                   |
