# A27: fresh simultaneous close and retained recovery

27 September 2026. Isolated loopback ledger; no hosted activation.

100 new campaigns with eight receipts each, 100 background pools each receiving a buy and sell, and concurrent browsing over 400 registered campaigns. Eight financial worker processes were running before the common closing time. The database also retains earlier cohorts and their scheduled jobs; this is not a clean 200-campaign registry. Existing journals, approvals and funding proofs remain intact.

Initial startup refused an attempt to assign a different policy to the existing shared RPC resource. No financial workers started on that attempt. The corrected profile uses a new versioned resource name; it does not overwrite/reset an existing bucket. Workers then started before close.

All 100 launch and 100 refund jobs have completed. Full fee activation and final reconciliation are still pending. The signer reached its retained 5 SOL/hour approval budget across consecutive cohorts, correctly refusing further signatures; neither journal nor limit has been reset. This is an additional throughput constraint, not a reason to grant larger financial authority automatically.

Provisional close-window measurements already exceed the five-second launch/refund start target. Therefore this run does not qualify the baseline for advertised 100-close capacity even if it completes correctly. Final exact balance, lock, receipt and outstanding-packet assertions remain to be collected by the running harness.

Browsing initially missed its target; [A29](A29-DIRECTORY-QUERY-COALESCING-2026-09-27.md) records the correction and later passing measurement under the same financial run.

The next opt-in experiment, `signer-balanced-360`, reserves four lifecycle processes, four recovery, two provisioning and one each accounting/harvest/economics (13 total; four slots each). Worker RPC partitions remain 240/s. A separately versioned signer-evidence partition is 120/s, for 360/s combined. Interactive, index and test-driver traffic remain additional. Signing frequency, spending limits, capability checks and campaign budgets are unchanged. The profile is persisted in the local fixture and a resume cannot silently choose another. This is test configuration, not a tested production capacity or a purchased provider quota.

Capacity/profile tests pass, including loopback/genesis restrictions inherited by the signer fixture. Subsequent evidence must retain both the observed latency failure and the spend-budget cooldown; neither may be hidden by a restart or renamed as a fresh pass.

## Final retained recovery

The fresh attempt timed out with 100 launched/refunded and 91 fee activations.
At 13:02 UTC the same fixture resumed against the original signer journal,
capabilities and packet history. It completed in 198 seconds after rolling-hour
capacity became available: 100 campaigns, 800 exact receipts, 100 SOL accepted,
100 SOL refunded, all 100 locks verified, all fee activations completed, zero
unresolved signed operator packets and zero held operating funds. The 100
background buys and sells were reconciled using their existing packets; they
were not repeated. Economic fee work drained with 100 lamports total retained
SOL dust and no pending token dust across the 100 background pools.

This is **recovery evidence**, not a fresh capacity pass. The original latency
failure and spend cooldown remain release blockers. The recovery's 400 fee job
starts also reflect the retained older cohorts in the shared registry. No
financial authority or spending ceiling was increased.
