# Launch escrow v2 settlement foundation

Separate from the active commitment-escrow v1. This version has **no withdrawal or successful-launch instruction**. Funding readiness is not evidence that a pool exists. Accepted funds remain refundable after the immutable launch deadline.

Existing instructions 0 initialize, 1 commit, 2 finalize, 3 refund retain v1 semantics. Instruction 4 settles one receipt permissionlessly after the commitment deadline; accounts are writable campaign and writable receipt. Instruction 5 checks funding readiness without mutation; its only account is the campaign.

A receipt is counted once on its first commitment. After closing, settlement stores `floor(committed * hard / total)` if oversubscribed, otherwise the full commitment. Repeated settlement is a no-op. The campaign accumulates each amount exactly once; no off-chain total or Merkle root controls that aggregate. Readiness requires every registered receipt settled, a nonempty campaign, aggregate accepted SOL at least the soft cap, funding closed, and the launch deadline still in the future. Failed campaigns cannot pass readiness. Rounding can make actual accepted SOL slightly smaller than the hard cap; the difference remains reserved for refunds.

Campaign layout: 128 bytes, `KIDSESC2`; existing v1 fields retain offsets through 97; receipt count at 104, settled count at 112, accepted aggregate at 120 (all little-endian u64). Receipt layout: 112 bytes, `KIDSREC2`; existing fields retain offsets through 96, settled flag at 97, accepted amount at 104. PDA seed names remain campaign/commitment, isolated by the new program ID.

Verification:

- `cargo test --manifest-path programs/launch-escrow/Cargo.toml`
- From localnet: `node launch-escrow-deploy.mjs`, then `node launch-escrow-verify.mjs`.

Deployment uses a separate immutable program identity and manifest. It never switches the application's active campaign. A future real pool adapter requires a new deployment and campaign, not an upgrade of this immutable fixture.
