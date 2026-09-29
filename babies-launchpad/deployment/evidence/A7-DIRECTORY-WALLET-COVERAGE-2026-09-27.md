# A7: bounded directory navigation and wallet read coverage

This is isolated feature-branch qualification, not a production release.

## Changes

- Directory pages request 20 campaigns and expose previous/next keyset navigation. Creator filtering and literal name/ticker/address search execute in the registry before pagination, so older launches are reachable. Migration 31 adds the creator/ordinal index on both PostgreSQL and SQLite. Query size, page size and duplicate query parameters are bounded or rejected.
- Explore no longer requests participant positions for every visible coin. A coin reads one position; Portfolio and creator management read the current page only. There is no silent first-24 truncation.
- Identical wallet reads share a promise. Changing owner or page aborts the obsolete transport; a late result cannot populate the new scope. Responses must match the authenticated owner and requested campaign set. Missing positions remain unknown. Drafts are read on creator screens and checked against their owner.
- Coin detail has independent cancellable reads, so a directory refresh cannot remove an older open coin. The detail response must match the requested full identity/address.
- Portfolio explicitly states directory-page coverage. Unknown eligibility, unread token balances, directory errors and invalid records are not turned into verified zero holdings. This is **not yet a complete indexed wallet portfolio**: people can page through launches; automatic discovery across all campaigns and outside-site transactions remains a separate gate.

## Evidence

- Bounded regression: **602 passed, 0 failed, 0 skipped**. Includes real PostgreSQL migration, creator/search pagination, concurrency and restore tests. Log: `/tmp/kids-directory-regression.log`.
- Feature-enabled production build passed (`VITE_KIDS_PUBLIC_LAUNCHES=1`), log `/tmp/kids-directory-build.log`.
- Browser rehearsal with 65 campaigns: older creator pages, search beyond the first page, positions beyond the former 24-campaign cutoff, one-coin position requests, wallet switch and React Strict Mode. Widths 1440 / 768 / 390 / 320: no overflow or page errors. Report `/tmp/kids-directory-qa.json`.
- Page reads never requested more than 20 positions; Explore requested none. Read-session unit tests verify cancellation and identical-request coalescing. Browser mock handlers can finish after an HTTP abort; this does not claim server work is cancelled. Hosted/shared RPC admission remains required.
- Visually inspected the mobile portfolio and corrected global navigation CSS inheritance: pagination now remains in document flow.

## Remaining gates

Global indexed wallet discovery, directory-wide sorting, hosted creator funding/media/wallet composition, representative mixed-chain capacity, coordinated restore, operations and security release qualification remain. No program upgrade, economic change, hosted deployment, public activation or push occurred.
