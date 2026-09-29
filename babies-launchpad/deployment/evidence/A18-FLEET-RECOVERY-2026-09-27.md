# A18: 100-campaign recovery and shared HTTP reads

## Actual-chain result

The retained isolated 2.5% ledger completed **100 Standard campaigns, 800 participant receipts, 100 SOL accepted and 100 SOL refunded**. Every receipt's exact accepted/refunded amounts and all 100 current liquidity locks verified. Operating holds returned to zero. Six separate lane processes shared PostgreSQL and one strictly scoped signer. Completion took 292,063 ms after the final recovery start.

This was a recovery workload, **not a passing simultaneous-close capacity gate**. The final workers started 141 chain seconds after the common close, following the failures described below. Lifecycle queue p95 was 90,024 ms, above the 5-second target. Other p95 queue results were recovery 242 ms, provisioning 238 ms, accounting 12,405 ms, harvest 233 ms and economics 224 ms. Fee work covered initial qualified jobs, not 100 continuously trading pools. A fresh pre-close mixed workload remains required.

## Findings fixed during the run

- Startup scheduling now respects typed admission waits and can resume the exact saved campaign/funding records without repeating deposits.
- New v3 workers return the persisted signature immediately after broadcast and reconcile it in subsequent durable jobs. A17's one-second SDK subscription was insufficient: this SDK starts a detached status lookup whose rejection could escape the caller's catch. The asynchronous v3 path starts no SDK confirmation subscription. Legacy wait defaults remain unchanged.
- Up to one second of admission waiting within an active RPC call allows multi-read work to progress without continuously restarting at its first read. This does not retry broadcasts or increase quotas. Persistent saturation still yields. SDK-wrapped local capacity errors do not exhaust financial retry limits.
- The finite test signer profile is restricted to the pinned isolated genesis and loopback endpoint: 600 requests/minute and 5 SOL/hour. All packet, capability, fence, journal and campaign operating-reserve checks remain. No production signing limits were changed.
- Job-start events record queue timestamps without secret packets or keys.

The first 2-campaign smoke also passed with all 16 receipts, all locks and zero held operating funds. It used default signer limits.

## HTTP load evidence

A real PostgreSQL-backed API served **3,000 requests from 1,000 concurrent logical clients in three rounds**, using a pool of 64 upstream HTTP connections. All requests passed. End-to-end p95, including time queued for a client connection, was **710 / 645 / 634 ms**; p99 was 734 / 670 / 662 ms. One hundred shared campaign reads served all visitors, with **zero visitor-triggered RPC calls**. The test overlapped the fleet's launch/refund/fee-activation work. Views were warm; authentication used a local service-token boundary, not external wallet sessions.

A separate direct 1,000-TCP-connection burst failed on this macOS host. A plain Node server with no application or database reproduced 835 connection resets out of 1,000; the host's listen-backlog ceiling is 128. The pooled result does not prove 1,000 independent origin connections, CDN/WAF behavior, geographic latency or hosted capacity. Those remain separate deployment checks.

## Regression

The full joined suite passed **670 tests, zero failures or skips**, including PostgreSQL, signer capacity, asynchronous packet retention, RPC admission and read-load guards. Private log: `/tmp/kids-fleet-final-regression.log`.

## Audit notes and follow-up

The operator journal contains both financial operation packets and budget-proof shadow packets; these are not duplicate on-chain transfers. Three unsigned/prepared attempts expired during earlier admission starvation. All funded outcomes reconciled, but terminal chain outcomes should also be persisted into both journal views after asynchronous recovery; that is the next correctness cleanup.

Private evidence: `/tmp/kids-fleet-100-async.log`, `/tmp/kids-fleet-read-pooled.log`, and the retained private fixture report. Keys and signed packets stay outside Git. No public financial activation, mainnet deployment or funded-program changes occurred.

Against the ultimate goal, exact recovery and shared-read behavior improve. The missed lifecycle latency target, fresh mixed workload, hosted isolation/providers, funding composition, wallet compatibility, monitoring, restore and security release gates remain open.
