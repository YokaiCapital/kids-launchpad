# KIDS security facts (mainnet, 23 September 2026)

Plain facts, read from the chain and the repository. No "safe" or "renounced" badge is claimed. Update this file with
every release; the coin page links to it.

## The program

| Fact | Value | How to check |
| --- | --- | --- |
| Program id | `BLiaZWNQoPm4mG4cXNm4sXifFqs1Xmxx12qD9T4Y5NeN` | Solscan, program account |
| Upgradeable | **Yes.** The program can be changed by its upgrade authority. | `solana program show BLiaZ…` |
| Upgrade authority | `EPwoPzJ5wuFgvMxUs7gQyUgb48dfZh4k6TxpZsTpWf2Y`, a single key held offline by the owner (not the keeper key). | same |
| Multisig or hardware custody | **Not yet.** Planned before public funds; until then the program is protected by one key. | this file |
| Deployed build | `ef584ae7…8923` (199,008 bytes), reproducible CI build of the published source. Build 2 (`9721a4d8…ae58`) is reviewed and waits for the upgrade. | `deployment/MAINNET-IDENTITIES.json`, CI run |
| What the upgrade key can reach | Unclaimed tokens in launch custody (participants, parents, dev), the fee cycle, future behaviour. It cannot restore the revoked mint or freeze authorities and cannot unlock the Raydium LP lock. | design, `docs/CLAIM-VAULTS-DESIGN.md` |
| Planned change | Claim custody moves to a separate, small distribution program whose upgrade authority is revoked after review. | `docs/CLAIM-VAULTS-DESIGN.md` |

## The test coin (campaign `8LmwBAa5…`, coin `8P47V2fj…`)

| Fact | Value |
| --- | --- |
| Mint authority | none (revoked in the launch transaction; read it from the chain, some scanners still show the funding-window snapshot when the program's own address held it) |
| Freeze authority | none (revoked at launch; new coins revoke it at creation) |
| From build 3 | both authorities are revoked at creation, before the campaign opens, so no scanner ever sees the coin as mintable |
| Metadata | **none** on this coin (created before metadata-at-creation existed). New coins get an immutable Metaplex metadata account in the mint transaction. |
| Supply in program custody | 56.5 % of the original supply at launch (43.5 % participants + 5 % + 5 % parents + 3 % dev), decreasing as claims are paid. It is program-controlled, not a wallet, but see "upgradeable" above. |
| Liquidity | Raydium CPMM pool `FAThun8y…`, 2 % fee tier, LP permanently locked (Raydium lock, fee key held by the campaign). |
| Trading fee | 2 % on this pool. New pools open on the 2.5 % tier once build 2 is live. LP earnings are split 98:20:25:25 (treasury, dev, parent A buyback, parent B buyback) of the SOL side; the coin side is burned under build 2 (converted to SOL under build 1). |

## Claims and proofs

- Participant claims: proportional to settled SOL, from program custody, no expiry.
- Parent claims: Merkle roots on chain (`parents` account). The snapshot inputs, allocation CSVs and roots are in
  `deployment/mainnet/snapshots/<campaign>/` in the public repository; `node localnet/claim-cli.mjs <campaign> <owner>`
  rebuilds the proof from those files, compares the root with the chain and can send the claim with the owner's own key,
  with the website and the API down.
- Dev: 1 % at launch, 2 % linear over three calendar months, from the on-chain launch time.
- Under the planned distribution program, only the two parent allocations expire (30 days from the on-chain launch),
  after which anyone can burn the remainder. Paid claims and SOL refunds never expire.

## The service

- The API holds no signing key. A separate signer service signs keeper operations only, each instruction decoded
  against a template, bound to the served campaign, with an hourly spending limit persisted on its volume.
- Reads reach the API only through the site's origin gate; direct reads are refused (verified 23 September 2026).
- Admin routes exist only on the owner's own machine, never on a hosted runtime.
- Backups: daily volume backups on Railway; the restore drill procedure is in `docs/RESTORE-DRILL.md` (first drill
  pending).
