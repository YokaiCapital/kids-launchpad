# KIDS public launches: decision register

Started 24 September 2026 (P0 of the public-launches plan, `KIDS-PUBLIC-LAUNCHES-IMPLEMENTATION-PLAN-2026-09-24.md`).
Every economic or custody parameter of the public product is listed here with its status. Nothing marked *proposed*
is a live default: a preset becomes live only through an activation record below, signed off by the owner, with the
preset hash and policy version recorded in the release evidence. Existing funded campaigns keep their sealed terms.

## Agreed (owner, 23 to 24 September 2026)

| Rule | Behaviour | Source |
|---|---|---|
| Trading fee | 2.5 % total pool fee on new launches (Raydium CPMM config index 7, `ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi`); no creator fee enabled; verified at creation and at launch | owner 23 Sep; Shartcoin live |
| Dev supply | 3 % of original supply: 1 % at successful launch, 2 % linear over three calendar months (UTC, month-end clamp), no cliff | owner; deployed vesting |
| Funding | Timed commitments to program escrow; reaching the hard cap does not close funding | deployed behaviour |
| Oversubscription | Proportional allocation `accepted_i = floor(commit_i × min(T,H) / T)`; excess refundable; no first-come priority | deployed behaviour (Shartcoin: 2,500 committed, 1,000 accepted) |
| Soft caps | New public launches around 50 to 100 SOL | owner, via the reviewer handoff |
| Liquidity | Accepted SOL funds the pool; LP principal permanently locked (Raydium lock, fee NFT to the program) | deployed behaviour |
| Authorities | Mint and freeze authority revoked at successful launch; program upgrade authority and metadata authority disclosed separately | deployed behaviour (freeze at creation, mint at launch on build 2+) |
| Token-side fees | Burned, never sold | owner 23 Sep; tag 26 |
| Wallets | Wallet Standard plus injected wallets; Phantom paused until whitelisted | owner 23 Sep |
| Public product | Launch replaces voting and submissions; compact responsive pages; real data only | owner |
| Blocklist | Site-side refusal now; on-chain enforcement in a later program version; refunds and paid claims never blocked by moderation | owner 23 Sep |

## Proposed, not activated

| Item | Proposal | Status | Activation record |
|---|---|---|---|
| Standard supply split | 48.5 % participants / 48.5 % liquidity / 3 % dev | proposed | none |
| Family supply split | 43.5 / 43.5 / 5 / 5 / 3 (as Shartcoin) | proposed for the new version; matches the live Family campaign | none |
| Default public preset | soft 50 SOL / hard 100 SOL | proposed | none |
| Larger preset | soft 100 SOL / hard 250 SOL, advanced option | proposed | none |
| Funding duration | two hours; creator picks a future UTC start or opens on confirmation; start enforced on chain | proposed | none |
| Launch execution window | two hours after funding closes | proposed; needs the worst-case settlement benchmark (Shartcoin: 196 receipts settled and refunded in 3 m 30 s) | none |
| Standard SOL-fee routing | 148/168 treasury, 20/168 dev; token side burns | proposed | none |
| Family SOL-fee routing | 98/168 treasury, 20/168 dev, 25/168 parent A, 25/168 parent B (as deployed) | proposed for the new version | none |
| Platform creation charge | zero marketing fee; creator funds the quoted setup and operation costs explicitly | proposed | none |
| Free parent-claim expiry | explicit policy for the new Family version only; existing campaigns never expire | unresolved | none |
| Minimum initial commitment | to be set from the receipt-griefing benchmark | unresolved | none |
| Per-receipt operational funding | committing wallet pays its own receipt rent; any execution budget quoted, never deducted | unresolved | none |
| Per-wallet cap | none on the live campaign (owner, 23 Sep); a program-level cap is a possible new-version feature | unresolved | none |

## Architecture decisions taken in P0

| Decision | Choice | Why |
|---|---|---|
| Program versioning | New program version for public campaigns; the live Family campaign stays on the current program and its claims path | a shared-program feature upgrade needs its own compatibility review; the 24 Sep buyback upgrade showed how a small change can stall a live keeper |
| Campaign identity | (genesis hash, program id, campaign address); slug is an alias only | plan §8 |
| Operational records | Postgres for registry, intents, jobs, leases, chain events, market cursors; chain stays authoritative for balances and entitlements | plan §8 |
| Signing | Existing policy-bound signer service, per-campaign keeper capability with no recipient, supply, claim or root power; creator wallet never signs operations | plan §7 |
| Branch | `feature/public-launches` in the one checkout, rebased onto `main` daily, merged by the deployer when the owner says ship | repository rules, section 1 |

## Activation records

None yet. Format: date, preset hash, policy version, owner sign-off reference, release commit, evidence path.
