# A3: durable publication and mint plans, 26 September 2026

Status: internal local-pilot components implemented; no public upload endpoint or
hosted publication activated. Actual Pinata writes have not been qualified here.

## Shared publication boundary

Schema 15 adds bounded publication receipts, daily usage/policy rows and immutable
mint plans. PostgreSQL stores identifiers and hashes, not image blobs, credentials
or private keys. Existing campaign/grant/claim rows are not rewritten.

`creation/publication.mjs` uses staged charging: commit a
provider attempt and its quota before calling the provider; retain charges for
uncertain outcomes; skip a completed stage on restart. A shared, short admission
transaction enforces both owner and global daily pin/byte ceilings. Replicas with
different ceiling configurations fail closed. HTTP work is outside transactions.

Publication requires an accepted Standard review, the configured private pilot
owner, explicit `publicationConsent` in that review, and an owned sanitized image
whose content hash matches the accepted draft. It accepts no arbitrary URL to
fetch. Image and JSON stages are bound to immutable operation/content hashes.
Old reviews without publication consent cannot publish private artwork.

`creation/pinata.mjs` uses the Pinata endpoints. Uploads carry
operation/content tags; recovery searches those tags and verifies the returned
immutable content. Bare CIDs remain unchanged. A missing/ambiguous recovery result
stays pending and never authorizes another POST. Timeouts/errors retain uncertainty.
Requests reject redirects, bound response bodies and keep the JWT off gateway
requests and out of returned errors. Only fixed provider/gateway origins are used.

Official provider contract references:

- [Pinata list endpoint](https://docs.pinata.cloud/api-reference/endpoint/ipfs/list-files)
- [Pinata SDK query construction](https://github.com/PinataCloud/Pinata-SDK/blob/master/src/commands/data/pinList/queryBuilder.ts)
- [Pinata IPFS API schema](https://github.com/PinataCloud/docs/blob/main/pinata-api-ipfs.yaml)

## Shared signer plan

`creation/mint-plan.mjs` seals the accepted name/ticker, published document hash/URI,
reserved mint, derived custody and RPC-observed mint rent in PostgreSQL. It verifies
both publication receipts and their request/owner bindings. Concurrent replicas
cannot substitute a new URI, mint or instruction intent. Subsequent signer reads
load this plan after restart instead of relying on a process-local file.

Preparation retries recognize a matching sealed plan when its lease is signing or
consumed. Unexplained signed stock and released/quarantined stock still stop for
reconciliation. Mint approval recovery can retrieve the *same originally approved
packet* after blockhash expiry; it cannot change or extend that blockhash. This
recovers the inventory-signature/journal-write gap. New signing generations remain
a separate, unimplemented recovery protocol.

## Required before enabling creation

- Implement and qualify the authenticated private upload/object-storage and image
  decode/re-encode pipeline. `loadOwnedImage` is a trusted dependency, not an HTTP
  upload endpoint. Its `sanitized` field must come from that pipeline, never the
  browser. Header/hash checks here are not a full image decoder or metadata stripper.
- Connect owned asset IDs/hashes and explicit publication consent to saved drafts
  and creator review. The existing UI/review composition does not yet supply them.
- Qualify real Pinata credentials, tag lookup, gateway availability and timeout
  recovery in the intended account with synthetic approved artwork. Tests below
  use provider fixtures and do not establish hosted provider compatibility.
- Schedule provider operations behind bounded media workers and shared provider
  rate/concurrency admission. Daily spending caps alone do not establish throughput.
- A request that crashed before POST but has an empty recovery lookup intentionally
  remains pending. Add an audited, bounded repair procedure; absence is not proof
  the provider never accepted an earlier request.
- Finish durable wallet offers, reconciled replacement generations, campaign
  provisioning/funding, creator UI, real-wallet tests and hosted load qualification.

## Qualification evidence

- 346 focused registry, scheduling, wallet, signer, mint, market, CSRF and creation
  tests passed with PostgreSQL enabled; zero failed or skipped. The latest targeted
  tests also cover a mismatched per-replica publication policy and preparation
  retries after signing/consumption.
- Ten concurrent publication callers produced one image attempt and one document
  attempt. Lost responses retained charges and recovered without a duplicate pin;
  empty recovery lookups stayed pending. This uses a synthetic provider.
- Ten mint-plan seal callers retained one plan. Foreign owners, fabricated
  publication receipts, changed review content/policy and metadata-hash mismatches
  were rejected.
- A new actual validator mint completed through this shared-plan source and the
  reused encrypted inventory. It recovered after the deliberate post-broadcast
  crash, then verified exact custody and revoked authorities. The provider/image
  source was synthetic; no IPFS content was actually published.
- Local genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`.
- v3 issuer: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`.
- Mint: `8Jz75TwztvtLbP18VoCCJ9av7DMpxYXJUZ223Zbbkids`.
- Signature: `2Rumyo3LWqqQM2eyRfxqKCmLEwuNFHgQNjLDyCtUCKJuVuHUrnFL8g7mBuWybKwSDJtGB9rD5XxcoXgzoLxd27Rx`.
- 718-byte packet, 44.1-second rehearsal, immutable on-chain metadata, consumed
  mint lease. No campaign was created by this mint-only qualification.
- Publication pattern scan: 766 files, zero findings. This is not a guarantee that
  all sensitive information is absent or a substitute for release review.

## Ultimate-goal check

Advances consistent creator intent across replicas, verifiable metadata and bounded
provider spending, while preserving old programs and paid claims/refunds. It does
not yet complete the creator journey or qualify public activation. Funding remains
disabled and no public-route or media-host allowlist was widened by this change.
