# A3: v3 keeper CPI cost exposure

The v3 capability signer now reserves rent paid inside launch and fee-state
initialization calls in its hourly spending estimate. The legacy signer and v1/v2
capability cost behavior remain unchanged. No grants, worker activation, hosted
deployment or smart-contract upgrade occurred.

The signer reads finalized rent values from its pinned ledger before the final
lease check. Concurrent reads are coalesced; outages, malformed values, chain
changes and expired evidence refuse signing. Freshness is checked again at the
synchronous signing boundary. No awaited RPC was inserted after lease authority.

Launch exposure includes the fee NFT mint, NFT token account, locked position,
lock LP token account and a conservative metadata allowance. Current v3 launch
code requests no metadata; the allowance is an upper bound, not a spend receipt.
The separately funded launch-authority PDA pays pool creation costs. Fee-state
initialization is charged to its actual signer/payer, the sealed treasury, and
cannot be attributed to another keeper. Combined top-level and CPI rent respects
the v3 capability rent ceiling.

## Validation

- 437 regression tests passed, zero failures or skips, with PostgreSQL and
  restore checks enabled.
- Tests cover payer/template changes, missing/stale/wrong-ledger evidence,
  aggregate limits, concurrent reads, timeouts, signing-boundary expiry and
  unchanged v1/v2 behavior.
- Read-only evidence from the owned local validator returned rent of 1,461,600
  (82 bytes), 2,004,480 (160), 2,039,280 (165), 2,672,640 (256), and 5,616,720
  (679) lamports. The launch keeper rent ceiling is therefore 13,829,520 lamports;
  fee-state rent ceiling is 2,004,480, plus network/priority fees in either case.

This qualifies cost estimation and refusal behavior, not complete campaign budget
enforcement. Per-campaign holds are not yet coupled to signer execution; actual
rent settlement still needs its own exact cost decoder and chain qualification.
Program/AMM binary qualification and release gates remain required. Against the
ultimate goal, operating lifecycle and production readiness remain **partial**.
