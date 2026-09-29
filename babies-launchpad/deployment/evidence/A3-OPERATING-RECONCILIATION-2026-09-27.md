# A3: isolated operating-cost reconciliation

27 September 2026. Local implementation and owned-validator evidence only.

## Result

Every v3 signer operating hold now atomically creates an idempotent reconciliation job in PostgreSQL. An independent accounting worker, scoped to the exact genesis, program, payer and policy, verifies the persisted signed packet against finalized chain evidence. It has its own RPC admission partition and needs no signer credentials. It cannot grant capabilities, fund an account, sign, publish a coin or start a launch.

Pending transactions and unavailable evidence retain their holds with bounded backoff. They do not become failures after a retry count, nor release money on a timeout. Scope filtering happens before leasing; a different payer or policy cannot consume and fail another account's job. A transaction rollback rolls back both the hold and its job.

## Evidence

- 458 regression tests passed, 0 failed/skipped, with concurrency limited to two test processes.
- Two workers with four slots each processed 100 funded campaign fixtures: 90 settled, ten retained unresolved holds. Restart revisited all ten. Different-payer, launch and harvest jobs remained untouched. This is PostgreSQL concurrency evidence with synthetic proof readers, **not** a 100-coin live-RPC capacity claim.
- Owned local validator genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`.
- Isolated v3 program: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`.
- Campaign: `Baq6NpnHJpErz5kR73XWoj75Ln42yDmA6nswxSHerMqx`.
- Operating funding: `2rQhjs3bf6ACboVrCGQmzoSLAmNoXKfTMveRtg21geHatoK3RFzorYAy9MU22jcirfQedbTF38gf8PE7P8mD1n8U`.
- Fee-state initialization: `27oAY5GX8TmxsQUeF29goeFwDw2zRs6uyNCQ8JhhYA8XAdqjSxdZZZyLNFzcnjmBjVcBYgAM9fjgW6PFGF2GCzWo`.

The actual signer refused unfunded work, persisted a signature before a deliberate interruption, then resumed the same transaction once. Accounting first observed the pending packet, stopped, restarted, and automatically settled 2,009,480 lamports from a 3,000,000-lamport funded budget. Held balance became zero; available balance was 990,520 lamports. Duplicate sending did not broadcast again. No manual reconcile call was needed after submission.

Reproduce with `qualify-operating-lock.mjs` to create a fresh owned campaign, then pass that campaign to `qualify-operating-signer.mjs`. The latter refuses an already initialized fixture. Both scripts verify the owned local genesis and deployed binary before any write. An initial rehearsal assertion used a nonexistent job `status` field; the corrected full rerun above passed against a fresh campaign.

## Operating requirements and limits

The accounting service uses `lane: accounting`, `programVersion: 3`, explicit `operating.payer` and `operating.policy`, and a reserved `rpcAdmission` allocation. Do not give every replica an independent provider budget or let accounting borrow lifecycle/refund/fee allocations. The service remains localnet-rehearsal only. Alert on old held balances, growing queue age and repeated evidence-unavailable checks; never clear holds to silence an alert. Preserve transaction history or a qualified archival source for cost evidence.

This seeds new holds only. A preexisting installation must inventory old held rows and backfill equivalent jobs before activation; there are no hosted users of this new isolated path. Trusted cost-template composition, complete funding policy, hosted provider/wallet qualification and deliberate release remain open.

## Ultimate-goal comparison

Verifiable money and concurrent operations improve to **partial**, demonstrated by exact local-chain settlement and independent PostgreSQL scheduling. Sustainable fee operations remain **partial** until the cost/provisioning and funding policy is complete. Public readiness is **not demonstrated**. No mainnet changes, public activation or old-program changes occurred.
