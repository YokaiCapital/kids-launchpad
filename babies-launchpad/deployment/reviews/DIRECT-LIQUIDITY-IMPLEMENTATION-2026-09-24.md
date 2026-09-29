# Direct liquidity implementation checkpoint — 24 September 2026

## Update — 25 September 2026

Owner selected **preserve treasury/dev fee entitlements from both permanent and temporary
LP**, superseding the earlier unresolved fee choice and recycle-with-principal candidate.
Only temporary principal enters the new recycling mechanism. Preserve existing token-side
fee burns as well. Implement and verify fee harvesting/principal accounting before enabling
this policy; the existing numerical model does not provide that accounting. No promise of
unchanged future revenue as LP shrinks. Stopping rule remains undecided; this answer does not
select 90 cycles. Older checkpoint notes below are historical. Nothing is activated.


Branch: `feature/public-launches`.

## Scope

Owner approved a separate Direct feature. Keep parent/Family and existing Standard launches.
Direct reuses the established prelaunch economics and changes LP custody after pool creation:
50% of initial received LP permanently locked, 50% temporary; recycle 3% of the remaining
temporary budget per daily cycle. Burn withdrawn child tokens, spend all withdrawn SOL on
that same child in the same pool, then burn the purchased tokens. New programs/IDs only.

## Delivered in this checkpoint

- `programs/kids-liquidity-v1`: isolated Rust economic/state-transition library, canonical
  draft codec, integer arithmetic, daily scheduling, sequence guard, bounded decode work,
  complete LP-budget trajectory validation, burn/SOL/LP effect assertions, remainder lock.
- `localnet/recycling/direct-policy.mjs`: strict matching policy encoding and offline model.
  Direct is a distinct mode. Unknown fields, legacy modes, altered split/rate and unsupported
  fee treatment fail closed. No implicit economic defaults.
- Existing v2 SDK/preset generation refuses a new `liquidityPolicy` it cannot hash or enforce.
  Historical all-LP-lock manifest stays pinned; existing Rust program source is unchanged.
- Versioning and design records distinguish owner decisions, candidate policies and activation.

## Verification completed

- Rust: **16 tests passed** (`cargo test --manifest-path programs/kids-liquidity-v1/Cargo.toml --offline`).
- JavaScript: **44 tests passed** (recycling suites, v2 policy/client and preset suites).
- `cargo clippy --offline --all-targets -- -D warnings` passed before the final additional
  validation/test changes; final Rust tests and formatting passed afterward.
- Publication pattern scan: **646 export files, zero findings**. This is a pattern scan,
  not a guarantee that no sensitive information can exist.
- `git diff --check` passed.

These are host/offline tests, not validator, SBF, audited contract or economic-safety evidence.

## Not delivered / not activated

There is no deployable controller entrypoint, account adapter, fixed CPI execution, new Direct
issuer, program deployment, keeper, production registry activation or Direct UI in this
checkpoint. No new code accepts funds. No existing program, campaign or live pool was changed.
Do not label this feature implemented end to end or ready to launch.

The library accepts **measured effects** as inputs because it is a kernel. An actual controller
must authenticate accounts and obtain those measurements directly around atomic CPIs. Letting
a caller supply them would destroy the security property. The estimate is not a price oracle.

## Open owner choices

Questions sent while implementing; no answer received at this checkpoint:

1. Continue until LP dust, or stop after 90 **successful cycles** and permanently lock the rest?
2. Recycle temporary-LP earned fees with its principal, leaving only permanent-LP fees on the
   treasury/dev route, or preserve treasury/dev earnings from both halves?

Both ending rules exist as explicit candidate library inputs. Only recycle-with-principal fee
handling exists as a candidate. None is a selected production default. A 90-cycle ending is
not a 90-day deadline when operations are skipped. First execution delay is explicit, at least
24 hours; a seven-day delay has not been selected. Price/reference guards, operation-cost
policy, minimum batch and controller upgrade authority still require engineering/release review.

## Implementation sequence to finish

1. Resolve the two economic choices, then seal complete terms and all identity bindings before
   commitment in a new Direct issuer. Preserve escrow liabilities and paid claim/refund access.
2. Implement the new controller account adapter; prove ownership, seeds, mints, delegates,
   authorities and new issuer capabilities. Exclude old campaigns/programs from initialization.
3. Atomic launch: measure initial LP, verify permanent Raydium lock, transfer exact temporary
   budget to the controller, and revoke child mint/freeze authority before finalizing.
4. Fixed atomic withdraw/burn/same-pool-buy/burn CPIs with chain-measured effect checks,
   authenticated price/freshness/deviation guards, constrained remainder/donation locking.
5. Full real-validator differential rehearsal against pinned Raydium binaries; failures,
   malicious accounts, replay, quotes, external LP changes, fee collection, mint supply,
   rounding, custody, compute and transaction-size evidence.
6. Durable execution/reconciliation, version-specific API/SDK/wallet validation, Direct create
   review and compact live liquidity/evidence UI. Preserve all existing parent/Standard routes.
7. Independent review, authority verification, exact public program/build evidence, then a
   separate release activation. Historical source is never upgraded to introduce this feature.

See `programs/kids-liquidity-v1/README.md` for the detailed chain adapter contract.
