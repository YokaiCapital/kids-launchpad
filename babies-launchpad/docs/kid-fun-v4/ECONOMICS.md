# Fixed launch economics — design analysis

The user-facing rule is simple: **Same launch rules for every kid.** Keep the math in this document and the optional Launch rules detail, not on the ballot.

The current design preset remains 55% curve / 35% migration pool / 10% parent reserve, split equally between parents. Net graduation target is 85 SOL. Minimum parent holding is 0.05% of each parent's supply, assessed separately. No treasury seed pool is assumed. Buyers provide real SOL through LaunchLab.

## What the model establishes

The local Raydium SDK was exercised at 0%, 10%, 25%, 50%, 75% and 100% of the raise. The accompanying script checks supply conservation, positive reserves, buy/sell round trips with integer rounding, intended sale cap, endpoint price continuity in the arithmetic, and eligibility threshold rounding. It also evaluates trade sizes, larger raises, fee sensitivity and parent-reserve sales.

[Reproducible script](economics-check.mjs) · [Recorded results](economics-check.json)

At 85 SOL net raised the modeled opening pool contains 85 SOL and 35% of token supply, valued at 170 SOL equivalent in total. The modeled ratio to FDV is 70%. This is not 170 spendable SOL. It is not a promise of whale-sized execution or continuing price growth.

## Actual trade-size sensitivity

For a full-range constant-product pool with zero fees, the average buy price premium relative to the price before the trade is input SOL divided by the pool's SOL reserve. This differs from the shortfall of output versus a zero-impact spot quote. Neither is a user-selected slippage tolerance.

| Opening SOL reserve | 1 SOL buy | 5 SOL buy | 10 SOL buy |
|---|---:|---:|---:|
| 85 SOL, current fixed pilot | 1.18% | 5.88% | 11.76% |
| 170 SOL, comparison only | 0.59% | 2.94% | 5.88% |
| 340 SOL, comparison only | 0.29% | 1.47% | 2.94% |

Larger raises improve absolute depth but require more genuine demand to graduate. They are analysis cases, not extra creator options or a silent change to the fixed 85 SOL preset. A claim of less than 3% average premium on a 10 SOL buy would need more than roughly 333 SOL quote reserve before fees. Do not advertise the 85 SOL pilot as satisfying that claim.

At 85 SOL, adding an illustrative 1% input fee increases the 10 SOL trade's average cost premium to about 12.77%. This is a sensitivity assumption, not a verified configured fee. Actual LaunchLab and post-migration fees must be published from the qualified configurations and shown in quotes. Zero token transfer tax does not mean zero trading fees.

## Parent allocation sell pressure

Without intervening buying, modeled sales into the opening pool give:

| Fraction of entire parent reserve sold | SOL paid out | Spot price decline |
|---|---:|---:|
| 25% | 5.67 | 12.89% |
| 50% | 10.63 | 23.44% |
| 100% | 18.89 | 39.51% |

These are stress scenarios, not predictions. The 10% allocation is economically meaningful. A higher opening ratio does not remove sell pressure. No undisclosed vesting, sell restrictions or extra taxes are introduced to make the model look better.

Existing KIDS allocation logic uses a 2%-of-parent-allocation per-owner cap (200 basis points), iterative proportional redistribution and remainder accounting. That is different from the 0.05%-of-parent-supply eligibility floor. Preserve and disclose inherited allocation rules unless explicitly revised; a wallet cap is not a person cap and can be evaded by splitting qualifying balances. Claims and unclaimed handling must match the published distribution record.

## Technical findings and launch gates

The low-level SDK amount-out calculation at the exact target overquotes the final sale by 2,499 raw token units (0.002499 token at six decimals) because of integer initialization rounding. The design model explicitly caps the intended sold amount; this does not prove on-chain enforcement. Verify the actual final-fill transaction and refund/cap behavior in simulation before use.

Still required before activation: finalized global/platform configuration; all fees and beneficiaries; successful buy/sell/final-fill simulation; actual graduation price continuity; LP custody/lock/burn rights; reserve unlock and funding; 0.05% snapshot processing at up to 2,000 owners per parent; and claim rehearsal. Executor rent and transaction costs require an operating balance, even though no seeded pool is required.

The strong part of this economic design is its explicit fixed terms and measured tradeoffs. It cannot honestly receive a proven >9 launch-economics score from SDK arithmetic alone. Qualification is evidence still to collect, not a disclaimer to hide behind after launch.

## Primary references

- [Raydium constant-product SDK](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/raydium/launchpad/curve/constantProductCurve.ts), checked 19 September 2026: reserve and quote mechanics.
- [Raydium launch configurations](https://launch-mint-v1.raydium.io/main/configs), checked 19 September 2026: advertised configuration; finalized chain state remains authoritative.
- Local `packages/asset-pools/src/community-allocation.ts` and `apps/api/src/community-snapshot-job.ts`: inherited allocation cap and redistribution.

## Follow-up: high-level SDK final fills

[Isolated qualification evidence](qualification/README.md) adds 36 passing quote cases using pinned SDK 0.2.71-alpha. The SDK's high-level `Curve.buyExactIn` caps the sale inventory and reduces quoted input on an oversize final fill. Original arithmetic also passes against the pinned installation. This resolves the offline quote-cap question only; on-chain final-fill/refund behavior and migration qualification remain open.

## Follow-up: finalized configuration and distribution boundary

At finalized slot 448531652, the SOL LaunchLab global configuration decoded under the expected program owner and agreed with the public config API on all tested fields. The 55/35/10 split and 85 SOL target satisfy its recorded bounds. Its protocol trading fee is 0.25% and migration fee zero; these do not establish total kid.fun or migrated-pool fees. Exact account bytes, addresses and checks: [chain evidence](qualification/chain-config-results.json).

An offline rehearsal over two synthetic 2,000-owner parent snapshots conserved the full parent allocation, verified 4,000 Merkle proofs and rejected altered-amount proofs. It used the inherited 2% allocation cap and the 0.05% eligibility floor. [Allocation evidence](qualification/allocation-results.json). No live snapshot, funded distributor, on-chain claim or launch transaction was executed. Launch qualification remains incomplete for the concrete missing inputs listed in [qualification notes](qualification/README.md).
