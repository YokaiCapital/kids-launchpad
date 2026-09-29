# A40: funding-first round through the real creator services and the signer composition on the isolated ledger (29 Sep 2026)

**Result: 28 of 28 checks passed** (`localnet/protocol-v3/funding-first-creation-localnet.mjs`, evidence
`kids-launchpad-recovery-2026-09-28/funding-first-creation-rehearsal-1.json`). Program `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`
(sha256 `6236f4e8ee6cd003…`), RPC 127.0.0.1:19199, PostgreSQL registry in a fresh schema, the real encrypted mint inventory
(temporary directory, one test-only vanity mint), a scripted metadata provider (no Pinata), funding window 240 s.

## What ran, in order
1. The pilot creator's services: reservation (inventory mint), publication + sealed version-3 plan (the custody reserved the fee
   NFT `Ha581EqB9RjTwaQAEhxSuHFBz6xfiZ65jVffs1PcFtdU` beside the mint `imWnXzvngxjrhGKzRbnXUznzLgQxWmpgXYpezf2kids` before the offer), one wallet approval of the opening packet
   (957 bytes, three signature slots), the custody co-signature (mint + fee NFT), broadcast of the exact bytes,
   finalized opening evidence from the immutable commitments (accounting version 2, no token), registration (accounting version
   2 + fee NFT recorded), the operating reserve (60,000,000 lamports) credited from the same packet. Opening `2cFs8T33tde79FkfBe1EBZ9H8WPjKNwX7V23tezTJYDiVEjEdFajH5vrhJLGdXwGhHwQLjcY8Zf14fKB9fRAyK8V`.
2. A participant committed 0.02 SOL (tag 2 on the version-2 record).
3. The keeper through the signer service (capability tag 42, the budget credited by the creator's reserve): table plan, table
   `2KbfcYRfFCqY9dZzFcL28u7GwV1ARW4ebxboPDj91aEv` created and extended (two packets, holds settled per packet), warm before the deadline.
4. After the sealed deadline on the confirmed clock: the launch (tag 42) through the table; the keeper signed via the signer
   service, the reserved mint and fee NFT via the custody adapter co-signing the journaled packet (1 co-sign call,
   attempt 1). Launch `5DaQBpGLeT5ZbYhYmJACfvczJTnva2QWaQKbj9JLqrTV42v5nkZAZugq92Y16pju7V7ch8AcQdwsHRJ9Xxbce4Cd`, slot 364608, fee 15000
   lamports, 349183 compute units. Live verification (version-2 branch) ok. Every hold settled
   from finalized evidence: table 5740040 + 2232200,
   launch 28883560 lamports; budget funded 60000000, spent 36855800,
   held 0, available 23144200.

## Timings (wall clock unless stated)
- Creator: approval to opening finalized 16.874 s; to registered and reserve credited 17.136 s.
- Table ready 49.7 s after the approval, before the deadline.
- From the sealed deadline: confirmed clock passed 2.544 s, launch phase confirmed 2.964 s, launch finalized 18.326 s, accounting settled 18.392 s; on the chain's own clock the launch block is 1 s after the deadline.

## What this proves and what it does not
- Proves: the connected path creator services -> custody -> executor evidence -> registration -> reserve credit -> keeper table ->
  custody-co-signed launch -> accounting, on a real validator with the real program bytes, with one creator approval.
- Does not prove: hosted timing (this host ran at load 11-14 with four validators), the automatic lifecycle (the keeper side was
  driven by the script, not by the job runner: no lifecycle jobs, no worker, no custody endpoint), metadata pinning (scripted
  provider), refunds/close/accounting/collateral (tags 44-47) and claims (43), restart/restore of the custody rows, or any
  hosted qualification. No speed requirement is claimed met.
