# A3 authenticated creator composition — 26 September 2026

Status: local implementation, HTTP admission and full browser-to-chain creator
qualification passed. This is not permission to enable public creation,
participant funding, workers or a hosted signing path.

## Implemented boundary

- `composeLocalCreatorHttp` explicitly composes PostgreSQL wallet sessions, the
  pilot account service, private artwork, quotes, publication, the existing
  encrypted mint inventory, three creator approvals and private registration.
  It requires the isolated v3 loopback configuration; production startup does
  not import it. The directory advertises private image uploads and exact fixed
  supply/treasury, while create/commit/claim/family remain disabled.
- New v3 quotes pin the server treasury into the review and request identity.
  Acceptance, preparation, mint planning, orchestration and campaign planning
  reject a changed treasury. Client-supplied caps or treasury cannot replace the
  server terms. Old funded programs and economics are unchanged.
- Mint offers now include the creator in their review, matching the browser's
  existing identity check. The joined HTTP rehearsal exposed this missing field;
  the fix preserves the independent packet checks before a wallet prompt.
- Explicit `backgroundServices: false` prevents this isolated API composition
  from starting legacy single-coin keeper/feed timers. The existing default is
  preserved; this is not a hosted deployment change.

## Tests and limits

The signed HTTP test verifies owner/foreign access, CSRF, binary image upload,
private no-store reads, metadata stripping, saved revisions, server-owned quote
terms, consent, idempotent acceptance, service reconstruction, logout revocation
and rejection of treasury substitution before inventory reservation. Quote and
acceptance do not publish, sign or reserve a mint. The reconciliation write gate
refuses side-effecting flow requests while permitting status reads.

The bounded-concurrency regression run passed **444 tests, zero failures and
zero skips**. An earlier unrestricted run saturated the local test environment
and hit media/recovery/capacity deadlines. A reduced-concurrency recheck, isolated
recovery check and then the full bounded run passed. Deadlines were not removed
or increased in the product. This does not qualify hosted throughput.

An initial actual-chain HTTP/controller run exposed the missing creator field.
After the fix, it completed mint approval and service-restart recovery, verified
finalized mint custody and reached native custody. Its four-minute harness bound
expired during slow validator finality; it is not counted as a complete run.
The rehearsal harness now has a bounded fifteen-minute journey allowance.

The browser harness uses real React wizard/account components and actual signed
HTTP requests. Its Wallet Standard adapter signs through an owned local test key
outside the browser. Private object storage is a memory fixture and publication
returns synthetic CID receipts. Neither an installed wallet extension nor hosted
object storage/Pinata is qualified by this exercise. The local Raydium clone uses
its existing 2% config; the production preset remains 2.5%.

## Completed browser-to-chain rehearsal

The actual Account and LaunchWizard components completed signed login, private
upload/crop, all four review steps, exact cost acceptance, fresh inventory
reservation/publication, three independent approvals and finalized registration.
After the mint approval, the backend services were reconstructed and the user
resumed through **My launches**, preserving the same request and mint. No API
failures or browser errors were recorded. No jobs or signer capabilities were
created; participant funding and worker activation remained disabled.

- Local campaign: `5ik3qSLARZXQLsXff2EjebewGBgkdnrUYNEcgEczvDxu`
- Fresh mint: `BR4tyx78622uMhC4P2EFgScNYpya7oK5ssBcNsJ1kids`
- Mint transaction: `2LQMMczWgmMfLvfri6HqhajBbkEm9QGbvZHQxxZvk9VsiQzd9S8YgYghDgPXyZoHv9ENeYNaYrFAjbYZzu8mmYUH`
- Native custody: `352duQneM6Kdh2uMNaWPvNLWF7j7fEXtiog4RopqTcBaNVXcPUuQxLkJ5NhTwfiaDkjtrXmUH7QxMvoMTi9fiZaE`
- Campaign creation: `2FUbQ6RjbhTf8T3GbWhq1de9zXjgy43T36nSrzKBTW74vJjJgjSHGWyLYRJ22hZHTiezswZUkobweT4nTJ9d51z6`

Completion-screen overflow checks passed at 1440, 768, 390 and 320 CSS pixels.
The mobile completion screenshot was inspected. This harness loads the isolated
creator components and their styles, not the entire application's shared shell;
it does not replace full-site visual QA or real-extension/mobile-wallet testing.
The browser harness and screenshots remain local outside the repository.

## Comparison to the ultimate goal

Creator integration has advanced, but the full public-launch goal remains
partial. Remaining gates include external wallets, hosted image/video providers,
complete operating funding policy, lock-cost settlement, signer-budget coupling,
activation and mixed chain/RPC workload qualification. No program upgrade,
mainnet transaction, repository push or public activation occurred in this slice.
