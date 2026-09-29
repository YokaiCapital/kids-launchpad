# A3: chain-derived operating costs and isolated fee setup

27 September 2026. Isolated v3 Standard implementation. No hosted/mainnet deployment or public activation.

## What is implemented

The Standard cost reader reconstructs every supported worker transaction from finalized sealed campaign terms and canonical accounts. It supports finalize/readiness, settlement/refund batches, launch lock rent, fee-state initialization, fee harvesting, distribution and child-token burns. It rejects mixed operations, changed flags or recipients, unreviewed priority instructions, foreign receipts and a refund recipient aliased to the operating payer. Direct, Family buyback, arbitrary ATA sponsorship and unsupported token extensions remain outside this composition.

Fee setup creates canonical child/WSOL fee custody and the sealed treasury/dev WSOL accounts, then initializes fee state, in one atomic packet. Existing accounts are idempotent and their rent is not charged again. A failed atomic packet charges only its verified network fee. The cost proof attributes only actual payer-funded rent top-ups and requires all other native balances to reconcile.

A specialized `fee-setup` capability exists only for explicit program version 3, tag 20 and one or two distinct sealed recipients. Both registry implementations reject other versions/tag sets. Before considering the message, the registry signer reads the actual campaign, checks owner, immutable terms hash, genesis, derived campaign address, Standard mode, sealed treasury payer and exact recipients. Existing keeper capabilities still cannot name recipients. The separately configured fee operator is pinned in the exact cost template, not supplied by an HTTP request.

The provisioning service serves only `fee-setup` jobs, with independent worker slots and reserved RPC/signer admission. It waits for a live campaign, uses the durable sender, and marks completion only after finalized account verification. It does not grant itself further rights or start harvest/burn/distribution jobs. An initialized fee state with a subsequently closed recipient account is reported as repair required; initialization is not repeated. Recipient-account repair is still a separate qualification dependency.

## Qualification

The final local run used:

- Genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`.
- v3 program: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`.
- Campaign: `FD6LNfDpjHVxLBNHFaETAkTDTnSaTTuGL3hWPozo8uHA`.
- Lock transaction: `4V3EvZyotZvmAotvLWAnrJQFitVkSreBJxnq2ZyhE1rJqgRtXqKUc3cFuZxQiU4SKuUN6wwFJvF3dR6G6UZsbBqL`.
- Fee-setup funding: `3N5JFsgUu1CNVQWUHqHdVjXeQGAgm2ar28z2GUXMX38XLcyzvnrfHrmGTyAJtnfzt1AVdbQLT7uJ7uCbi36wNQES`.
- Fee-setup transaction: `47QDGrz8aGxjNBdeUv4ybmtGMCReT5ysHf6cvSC9Acxt2ycLiQ1F3jm8H1sp4NFgg7EoyHxdwafe2SqDtx6rWgA`.

The scripts verify the owned local genesis and deployed binary before writes. The lock cost reader qualified the exact 1,201-byte packet. Launch charged 8,212,800 lamports of rent plus 10,000 network fee; released the unused 5,616,720 metadata allowance; preserved the full 1 SOL refund liability; and passed locked-liquidity/mint/freeze readback.

The remote signer refused an unfunded request. After explicit 12,000,000-lamport test funding it persisted the approved fee-setup signature before a deliberate interruption, resumed that same packet, and broadcast once. Two canonical token accounts already existed; two were newly created. Actual cost was 6,088,040 lamports (fee state plus two ATAs plus 5,000 fee). The independent accounting worker recovered after restart, left no held balance and reported 5,911,960 lamports available. The provisioning worker independently verified all four accounts and completed without another broadcast.

A rehearsal found that a confirmed campaign slot was newer than the requested finalized account view. The provisioning service now reads campaigns at finalized commitment. A lagging finalized provider yields and retries without signing or exhausting the setup job. The corrected complete rehearsal passed; a regression reproduces the lagging-provider response.

Tests cover changed recipients/operators/flags, extra transfers, priority instructions, foreign/duplicate receipts, invalid grants, exact setup rent with preexisting accounts, failed atomic transactions, live/finality waiting, altered custody and no automatic activation. The broader final regression result is recorded in the integrated-plan checkpoint. A narrow secret-pattern scan of 825 tracked/untracked text files found no embedded private PEM, GitHub/AWS token patterns or literal Solana secret-key arrays; this is not an independent security audit or a proof that all historical commits are clean.

## Safe composition order

1. Register the isolated v3 campaign and obtain its exact reviewed operating policy and finalized funding evidence. No participant escrow, pool reserve or claim custody is an operating budget.
2. Compose the signer with `createStandardOperatingCostReader`, the durable funding packet loader and `createOperatingSignerBudget`. Preserve the single-writer signer volume and use shared admission.
3. After verified launch, issue a short-lived fee-setup grant for the exact sealed treasury/dev. The setup signer must be the sealed treasury. Enqueue the fixed `fee-setup` operation in the provisioning lane.
4. Await finalized setup verification and accounting settlement. If the fee operator/custody differs, investigate; do not rotate an operator or change recipients to force a pass.
5. A separately qualified activation coordinator must replace setup rights with ordinary keeper rights and seed recurring fee jobs. This checkpoint deliberately does not implement that funding-policy-dependent activation.

Run the owned local `qualify-operating-lock.mjs`, then `qualify-operating-signer.mjs` with its fresh campaign. The second script refuses already initialized fixtures. All private funding packets and signer state stay outside tracked source.

## Remaining gate and ultimate-goal comparison

Verifiable money, sustainable fee operations and reliable concurrency are **partial**, with concrete chain and PostgreSQL evidence. The ordinary local setup packet and worker are implemented; public automatic activation still needs the selected ongoing-cost policy, explicit durable funding/activation composition, recipient-account recovery, external-wallet/provider qualification, representative mixed-load/restore drills and the separate security/release gate. Existing programs and funded launches were not modified. Future Direct recycling and Auto MM remain separate inactive versions.
