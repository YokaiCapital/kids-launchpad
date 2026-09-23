# KIDS

Two communities. One new coin.

KIDS uses a timed SOL commitment window and proportional allocation to give accepted participants the same token rate within a campaign. It starts with coins connecting two parent communities: Shartcoin brings together Fartcoin and Buttcoin.

This repository contains the launch and distribution programs, application and operational tooling. KIDS-owned code is licensed under **PolyForm Noncommercial 1.0.0**, not OSI open source. See [LICENSE.md](LICENSE.md), [NOTICE](NOTICE) and [licensing](docs/LICENSING.md). Other components retain their own licenses.

## Read before committing

- SOL commitments are deposited into the campaign's program-controlled escrow account, not a personal dev wallet. The exact escrow must match the campaign you selected.
- Below the soft cap, a failed campaign makes commitments refundable. Above the hard cap, accepted amounts scale proportionally and excess becomes refundable. Network fees are not refunded.
- A successful launch pairs accepted SOL with the liquidity allocation, locks the issued LP position and revokes token mint/freeze authorities. Receipt settlement may happen in earlier transactions; inspect the final launch transaction and state rather than assuming every step happened in one transaction.
- Program control is not the same as immutability. The upgrade authority table below explains who can change deployed code. Published source does not, by itself, prove which binary is running.

Read the [site guide](https://kids.fun/#docs/start) for commitments, supply, rewards, fees and claims. Financial actions should remain unavailable when verified live state cannot be read.

## Deployment and verification

**Observed 23 September 2026 on Solana mainnet, using finalized RPC state.** Program observations were read at slot **449603719**; campaign observations at slot **449603762**. This is a point-in-time read, not a promise that an upgradeable deployment will never change.

### Launch program

| Fact | Verified value |
| --- | --- |
| Program ID | [`BLiaZWNQoPm4mG4cXNm4sXifFqs1Xmxx12qD9T4Y5NeN`](https://explorer.solana.com/address/BLiaZWNQoPm4mG4cXNm4sXifFqs1Xmxx12qD9T4Y5NeN) |
| Executable | Yes; BPF Upgradeable Loader |
| ProgramData | [`G3suWTB76JaM13CHPwpPdGiKp7XV1RiBknSKggEexBqP`](https://explorer.solana.com/address/G3suWTB76JaM13CHPwpPdGiKp7XV1RiBknSKggEexBqP) |
| Upgrade authority | [`EPwoPzJ5wuFgvMxUs7gQyUgb48dfZh4k6TxpZsTpWf2Y`](https://explorer.solana.com/address/EPwoPzJ5wuFgvMxUs7gQyUgb48dfZh4k6TxpZsTpWf2Y) — active, not revoked |
| Last deployment slot | 449587525 |
| Source | [programs/atomic-launch](babies-launchpad/programs/atomic-launch) |
| Deployed build | SHA-256 `9721a4d8b7cdcc4aebe11ca54d968e0be73d0e2dfea261e4954eeacdc7d8ae58` over the first 200,784 bytes of ProgramData (the rest is zero padding), read from the chain on 23 September 2026 after the upgrade `5CBxyEGnWFUohPBL4JTD4YGNfCdJCoZMYGs7JomjuAVHnG3gG85miiHGs3e4K7iu4696ph7YPoatgt6nEYJrzYf` |
| Reproducible source | commit `1b1c47f`, built on two independent GitHub runners by [.github/workflows/sbf-build.yml](.github/workflows/sbf-build.yml); both produced that hash. Anyone can rerun the workflow and compare with the chain. |

**The launch program is upgradeable.** Whoever controls the upgrade authority can replace its code. Its present source rules are not an immutable guarantee protecting assets controlled by this program.

### Existing launched campaign

This is the existing mainnet campaign, recorded in launched phase **3**. It must not be confused with a fresh campaign using the new separated distribution design.

| Account or fact | Verified value |
| --- | --- |
| Campaign / escrow | [`8LmwBAa5XquvtUrsKrvspfV6da9T7sHiXXMVDmEdYew`](https://explorer.solana.com/address/8LmwBAa5XquvtUrsKrvspfV6da9T7sHiXXMVDmEdYew) |
| Child token mint | [`8P47V2fj1yfg1C76YAZEXJBVzDJBFfURUUTeJjVJq5bz`](https://explorer.solana.com/address/8P47V2fj1yfg1C76YAZEXJBVzDJBFfURUUTeJjVJq5bz) |
| Token program / decimals | Classic SPL Token; 6 decimals |
| Mint authority | None |
| Freeze authority | None |
| Pool recorded in campaign | [`FAThun8yCqyatCAmcUAfqdmD83zHN3RZieEk6FkB5Zcn`](https://explorer.solana.com/address/FAThun8yCqyatCAmcUAfqdmD83zHN3RZieEk6FkB5Zcn) |
| Fee Key recorded in campaign | [`4kx57DzKkf2Tuiadwki8eW87MTosaqSjUf3G6wU8bMG2`](https://explorer.solana.com/address/4kx57DzKkf2Tuiadwki8eW87MTosaqSjUf3G6wU8bMG2) |
| Dev beneficiary | [`EkqTC1NbAg9zjFxdWY4psYtyHU3JpXDeXCkerSahraSJ`](https://explorer.solana.com/address/EkqTC1NbAg9zjFxdWY4psYtyHU3JpXDeXCkerSahraSJ) |
| Treasury beneficiary | [`91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX`](https://explorer.solana.com/address/91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX) |
| Separated distribution program binding | Unset: all-zero public key, conventionally displayed as `11111111111111111111111111111111` |
| Separated distribution activation flag | False |

The all-zero binding above is **not** a distribution program ID. The existing campaign has **not activated the new separated distribution vaults**. Its legacy claim custody remains governed by the launch program, including that program’s upgrade authority. The fresh-vault 30-day free-parent expiry policy must not be inferred for this older campaign.

Launch transaction: `4x6SEETKp9EV89pRY1PJQx7CTxhHxdnxLB2bJwrnhV7PHF7sbsHXLMefShUUDFJa2mCW68pJozU7ef2ZxcfKQoba` (23 September 2026, 02:08 UTC). Pool fee tier: 2 % (Raydium config `2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5`, read from the pool). Fee harvesting redeems the accrued fee share of the locked position (Raydium CollectCpFees, then Withdraw), so the locked LP unit count decreases by the harvested share over time while the principal stays locked; see [docs/SECURITY-FACTS.md](babies-launchpad/docs/SECURITY-FACTS.md) for the current facts and their limits. Canonical external program IDs and their governance should be added only after checking the actual bound accounts. No unverified address is substituted here.

### New distribution design

[programs/kids-distribution](babies-launchpad/programs/kids-distribution) implements purpose-specific participant, parent A, parent B and dev vaults in the inspected source. A verified mainnet deployment ID and authority-revocation evidence are not available in this registry. Do not call it deployed or immutable based on source existence, or label this older campaign as migrated.

For every future deployment, publish the source commit, reproducible build procedure and artifact hash separately from the result of comparing it with deployed bytecode. An artifact hash alone is not that comparison. Keep old campaigns and their custody arrangements visible when publishing a newer deployment.

## Who can move funds?

| Asset | Intended rule | What must be checked |
| --- | --- | --- |
| Committed SOL | Campaign receipt accounting and launch/refund instructions | Campaign terms; actual deployed code; launch program upgrade authority |
| Purchased tokens | Paid to the receipt owner from participant custody | Distribution version, program authority and replay protection |
| Parent reward reserves | Paid to proved eligible owners; free-only deadline and burn for new distribution campaigns | Snapshot roots, proof availability, activated terms, upgrade authority |
| Dev reserve | Fixed dev beneficiary: 1% at launch and 2% linear over three calendar months | Beneficiary, exact timestamps and governing distribution version |
| Locked LP principal | External lock program enforces permanent lock | Canonical lock record, locked amount and external program governance |
| LP fee earnings | Collected through retained fee rights and routed according to verified program rules | Fee Key custody, fixed recipients, route bounds and upgrade authority |

The current source is intended to provide no arbitrary administrator withdrawal of user escrow or claim reserves. **That statement must not be represented as proof that an upgradeable program can never be changed to move its custody.** A key able to upgrade a controlling program is a material power. Revoking a token's mint and freeze authorities does not remove this separate power.

Separate vaults make the allocations easier to inspect. They become protected from code changes only when the controlling distribution program's immutability is verified. Do not describe an older launch-program custody account as an immutable new distribution vault.

A website password or local-only admin interface controls application access; it is not the mechanism securing on-chain user balances. Users should be able to independently inspect the relevant program and campaign accounts.

## Allocation and claims

| Purpose | Original supply | Release |
| --- | --- | --- |
| Prelaunch participants | 43.5% | Successful launch, proportional to settled accepted SOL |
| Liquidity | 43.5% | Paired with accepted SOL |
| Parent A holders | 5% | Snapshot entitlement |
| Parent B holders | 5% | Snapshot entitlement |
| Dev | 3% | 1% at launch; 2% linear over three calendar months, no cliff |

Parent eligibility requires at least 0.05% of the relevant recorded parent supply at the campaign snapshot. Each parent is checked independently. Eligible balances share that parent's reserve proportionally; it is not an equal amount per wallet.

For campaigns using the activated new distribution policy, free parent claims are available for 30 days from successful launch. At expiry, remaining free-parent reserves can be burned. **Purchased claims, unpaid SOL refunds and vested dev entitlements do not expire.** Earlier campaign terms must be read individually; this policy does not retroactively erase rights.

On-chain calculations use integer units. Final settled receipts and recorded allocation terms govern rounding. Supply burns do not increase allocations fixed against original supply.

## Trading fees and buybacks

Read the actual pool's trading-fee configuration. The total pool fee is not the same as the LP earnings collected by KIDS and is not a transfer tax.

The inspected source routes collected SOL-side earnings in weights **98 : 20 : 25 : 25 out of 168** to KIDS treasury, dev, parent A and parent B budgets. These are weights of collected SOL earnings, not guaranteed percentages of all trade volume. The current intended policy burns child-token fees directly and buys and burns the parent tokens with the two reserved SOL budgets. A queued budget is not a completed burn; check each transaction and use token decimals when reading raw counters.

Deployment verification must establish which fee paths are enabled in the actual binary. The presence of a burn instruction in a source file is not proof that a legacy sell path is disabled in the deployed program.

## Security and dependencies

An equal commitment rate removes an early-entry price advantage during the window. It does not prevent concentrated ownership, all Sybil behavior, aftermarket MEV, market manipulation or price losses. Nothing here promises a ban on specific wallets trading a classic token through a permissionless external pool.

Snapshot proofs show inclusion in a fixed root; the publisher's historical data collection and exclusions still need review. Public proof artifacts and direct claim instructions are needed for users to retain practical access if the website is down.

Raydium, Jupiter where used, Solana, wallet software, RPC/indexing and service availability have their own failure modes. Liquidity locking does not guarantee liquidity value or token price. Passing automated tests is not an independent audit.

### Release evidence

| Evidence | Status / reference |
| --- | --- |
| Public source for the deployed release | This repository. Visibility is set by the owner; the deployed release is tagged in the commit history and recorded in [deployment/MAINNET-IDENTITIES.json](babies-launchpad/deployment/MAINNET-IDENTITIES.json) |
| Reproducible build and deployed bytecode match | Established for the launch program on 23 September 2026 (hash above); redo after every upgrade |
| Mainnet program authority read-back | Finalized slot 449603719 on 23 September 2026; active launch upgrade authority shown above |
| Campaign distribution activation | Finalized slot 449603762; unset program binding and false activation flag |
| End-to-end launch, claims and refund qualification | Release-specific qualification evidence is not independently linked here |
| Independent contract audit | No independent audit evidenced in this review |
| API/signer security and operational recovery | Separate verification required; not certified by program-account reads |
| Public snapshot proofs and direct claim route | Snapshot inputs, allocation CSVs and roots per campaign under [deployment/mainnet/snapshots](babies-launchpad/deployment/mainnet/snapshots); `node localnet/claim-cli.mjs <campaign> <owner> [--send key.json]` rebuilds proofs, compares roots with the chain and can claim without the website (verified read-only on mainnet, 23 September 2026) |

## Repository guide

- [Launch program](babies-launchpad/programs/atomic-launch): escrow, settlement, launch and fee instructions.
- [Distribution program](babies-launchpad/programs/kids-distribution): purpose-specific claims and free-parent expiry.
- [Localnet tooling](babies-launchpad/localnet): reproducible isolated launch and claim qualification.
- [Frontend](babies-launchpad/interaction-review): public site, API and wallet interactions.
- [Security facts](babies-launchpad/docs/SECURITY-FACTS.md), [claim-vault design](babies-launchpad/docs/CLAIM-VAULTS-DESIGN.md), [restore drill](babies-launchpad/docs/RESTORE-DRILL.md).
- [License and attribution](babies-launchpad/docs/LICENSING.md): reuse rules and separate third-party rights.

Consult each component's README for prerequisites and commands. Some historical component documentation describes earlier localnet work; the dated deployment table above must remain the source of current deployment identity.

Never commit seed phrases, private keys, RPC credentials, service tokens, signed session cookies, environment files or runtime ledgers. Public program IDs, mint addresses and transaction signatures are intended verification material; secret signing material is not.
