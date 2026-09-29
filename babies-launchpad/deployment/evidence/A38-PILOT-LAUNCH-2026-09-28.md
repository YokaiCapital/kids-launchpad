# A38: Standard v3 private pilot, 28 September 2026

## Approval blocker

Owner-reported error: `Creator transaction differs from your reviewed launch`.
The browser controller passed the configured network when accepting the offer, but
omitted it when decoding the same packet immediately before signing. The decoder
then defaulted to `localnet`, rejecting a valid `mainnet` review before invoking
`signTransaction`. This reproduces the reported error without a wallet extension.
It is distinct from the post-signing message-change error.

Implemented: pass the configured network at both decoding boundaries. The exact
transaction reconstruction and signature checks remain enforced. No program,
transaction, stored request, reserved address or signer journal is replaced.

Tested: a new controller regression failed with the exact reported message before
the fix and passes for mainnet and devnet afterwards. Existing tests still reject
changed terms, destinations, networks and ownership, and retain the same signed
bytes after a lost response. Two stale tests now assert the already-approved pilot
preset (1 SOL soft cap, 5 SOL hard cap), with no public default selection.

Required checks: 422 passed, zero failed, one skipped (optional video transcode
fixture); public-launch site builds passed with default and mainnet settings;
program host tests: nine passed.

Deployment: fix `b32803d` pushed; both KIDS release checks runs passed
(`36455651756`, `36455656845`). All nine Railway pilot services reported SUCCESS.
At 17:08 UTC the API was ready, all release checks true, alerts empty; mint reserve
was two available, four reserved, zero signed. The existing local pilot server on
port 5173 serves the corrected module. This records the code release; a subsequent
records-only push must separately pass its release checks.
Verified live: pending the owner's wallet approval; no mainnet creation signature
is claimed by this record. Browser interaction could not be inspected because
computer-use permission was unavailable.

## Pilot request

- Request: `a0f49ec9-723b-46c4-8ec8-a89e5ee9111b`
- Reserved mint: `4nVTgLJispDNSNybmxZ8ScGHbFfmtmgihmcKd88Tkids`
- Campaign: `AKRz4b3sBFDBpuZ6WNxftEoTTBXDAHhT5hfDmbaRMpQq`
- Creation signature: pending.
- Keeper grant and schedule: pending confirmed creation.
- Commitments, settlement, pool, lock, refunds, claims, trade and fee distribution:
  pending; no end-to-end mainnet success is claimed.
- Failed-launch refunds and reserve return: pending a separate pilot.

The initial hypotheses about wallet fee rewriting, missing mint signatures and
expired blockhashes remain unconfirmed. Do not weaken transaction checks to treat
this network-selection failure as a wallet modification.

## Isolated HTTP rehearsal

Completed on validator port 19199 with the owned local test key and synthetic
publication receipts. This is not an external wallet or mainnet qualification.

- Request: `c915acbf-2ced-42b8-a561-410b7f8bdd3a`
- Campaign: `2y4Pndshf1wAKq6C8mTirZR9wEANZp3Xf4dtjWFs8e5u`
- Mint: `E66J2GMvb1SiESjD6FZdhx4T9EhH5UG8feQGZh1kids`
- Creation and reserve signature:
  `2Xxsj5HeTMQM8oeNqDvyukKnqDkXykNzDzgRZJ7dnecgszco8GTcLaaUqc6We7kL5nSZe7LDg1kLPoNTyCEQAtEm`
- One independent approval, one creation transaction; 18.26 seconds from first
  approval to complete finalized records, including a forced service restart.
- Finalized registration, published profile, 100000000 lamports credited to the
  operating reserve at slot 300366; three read-only discovery jobs, no keeper grant.
- No journal or ledger reset. The test did not modify the compute budget.
