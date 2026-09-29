# A37: one-transaction creation, local rehearsal, 28 September 2026

Result: one click, one wallet approval, one transaction. The token, its custody, the campaign, the setup budget and the
operating reserve were created by a single transaction on the isolated validator; the creator signed once. The
transaction was confirmed within seconds; the records (finality, registration, reserve credit) were complete 17.8 s
after the approval, including a service restart the tool forces after the approval. Not mainnet: the program build
with tag 40 (`ec8f9951…`) waits for the owner's upgrade.

## What ran

Two runs of `localnet/creation/qualify-creator-http.mjs` in its default one-transaction mode against validator 19199
(program `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`, localnet-feature builds of the same source as the mainnet
builds; the local treasury and pilot keys are compiled in):

| Run | Source | Mint | Campaign | Creation signature | Approval to complete |
| --- | --- | --- | --- | --- | --- |
| 1, about 13:55 UTC | before the review fixes (local build `ec593b35…`, mainnet build `8206dc7a…`, never deployed) | `3CC6…kids` | `8VKJ…RgqE` | `5XZR…MoRk` | 17.8 s |
| 2, about 15:05 UTC | final source (local build `2857305e…`, mainnet build `ec8f9951…`) | `H7HQwM2Gwn21k6uuHhjXCtdpjVJKgV5Aa4zyfsyNkids` | `E17N9xowB1keY8roApq7Y6B5eSHtnrr9Ajz6kMoaSPGi` | `RoLPgPDrPRr6G9P9ztsSuqCt2smfgqDgzJFMBPnf7H8NX2cfhBsSBVD4Y5aMREGzRq9UX9VA6viZRBSbV48X4jH` | 17.9 s |

- Real parts: HTTP API with signed PostgreSQL sessions, image and video processing, chain quotes, the mint inventory
  (a fresh `kids` address is ground for each run in a throwaway inventory on this Mac; the hosted API keeps its own
  reserve), the creator controller and the browser's packet check, the owned local test key as the wallet. Fixtures:
  private object storage and publication receipts (no hosted Pinata), no wallet extension.
- Stages seen in both runs: reservation, publication, launch (the one approval), service restart, registration,
  operating-reserve, complete.
- Final run, on chain: slot 284598, block time 1790606905 = the sealed opening time, fee 19,999 lamports, 102,697
  compute units for the packet (the compact create 21,818), 2 signatures, 11 instructions, 16 accounts, no error.

## Checks the tool made

- Signed stages `['launch']`, one wallet approval, the service restarted after the approval and the flow resumed by
  request id.
- The reserve's signature equals the launch signature; the funding transaction's fee payer is the creator; the payer's
  balance rose by exactly the reserve; the budget row reserved the reserve with nothing spent.
- The creation transaction has 2 signatures and 11 instructions; the sealed opening time is within 5 s of the block
  time (it is equal).
- Campaign account owned by the program, child mint and treasury as expected, registered as version 3 with the three
  read-only discovery jobs; profile and video published (fixture receipts).
- Whole-suite state at the time: creation suites 419 pass, 1 skipped; application suites 400 pass, 4 skipped; program
  unit tests 8 (v3) and 69 (v2).

## Timing

17.8 s from the approval to the complete record. Of that, the finality wait is about 13 s (evidence is read at
`finalized` on purpose, rule 5 of the reliability rules), the forced service restart and the tool's 500 ms polling
make up the rest. The creator sees "Your coin is created" as soon as the transaction is confirmed (seconds); the
records finish in the background.

## Probes on the final build (`ec8f9951…`, localnet-feature build `2857305e…` on the same validator)

- **Same nonce again:** refused on chain, "instruction requires an uninitialized account" (the campaign exists).
- **Raw body with a 31-day funding window**, built past the client check: refused on chain with custom error 104
  (the program's 30-day bound).
- **Fresh nonce, same mint:** a second campaign sealing the same mint lands (review item T40-I7); only one can ever
  launch, the other fails its launch and refunds; the lease system prevents it in the product.
- **Client:** a 31-day window is refused before any packet is built.

## Not covered here

- Mainnet: build `ec8f9951…` was deployed after this evidence was written (28 September 14:57 UTC, slot 451352437); the pilot
  launch itself, through the UI on mainnet, is still to be run and recorded.
- A wallet extension (Phantom) and the hosted Pinata publication.
- The audit of tag 40 is recorded separately in `deployment/reviews/PROGRAM-LAUNCH-V3-2026-09-28.md`.
