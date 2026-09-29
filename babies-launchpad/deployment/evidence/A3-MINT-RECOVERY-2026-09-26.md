# A3: finalized mint recovery, 26 September 2026

Status: isolated v3 mint leg qualified locally; complete creator flow remains implementing.
No hosted deployment, existing-program change or public activation.

## Delivered

`localnet/creation/mint-execution.mjs` resumes a fully signed packet from the
existing PostgreSQL approval journal. It cannot create a replacement blockhash,
mint key or signing generation. Provider errors and timeouts remain pending;
retries can only broadcast the identical stored bytes. Observed transactions wait
for finality instead of being resent. Finalized failure/expiry requires attention
and never releases the reserved mint.

Before allowing provisioning to continue, `mint-result.mjs` verifies a finalized
account snapshot at or beyond the signature's slot: exact supply/decimals,
revoked mint and freeze authorities, full expected PDA custody without delegate
or close rights, and immutable Metaplex name/ticker/URI. Evidence is journaled
before lease consumption, so a crash between these writes is recoverable. No RPC
call holds a database transaction. Each RPC operation has a bounded deadline.

The executor intentionally does not publish metadata or create the campaign.
Immutable on-chain metadata can reference an unpublished URL; these checks do
not prove content availability. Owned upload/publication, trusted shared plan
storage, initial-signature recovery after expiry, bounded replacement generations,
full funding/provisioning and wallet/UI integration remain required.

## Evidence

- Eight tests passed: account/authority tampering, missing/stale evidence, lost
  submission response, identical rebroadcast, confirmed-versus-finalized states,
  provider timeout, network mismatch, cancellation, finalized failure/expiry and
  concurrent restart after the evidence write.
- The opt-in existing inventory rehearsal passed in 64.2 seconds. It ground a
  new lowercase `kids` mint, reused the encrypted signer after restart,
  deliberately crashed after broadcast, then resumed from the shared journal.
- Local genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`.
- v3 issuer: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV`.
- Mint: `2yDEU6QrhhsgLuS6GsiEd9FsC3pxwhEFNUfa1yuqkids`.
- Transaction: `2wM2YRU2r8aztG8k5CJLVuwFu46WuNMp1j6f9e4DD7bHdcUhJKBmBmmR5vhs74P1bn7zTC61Ce7SEe3cKwTRio55`.
- Packet: 719 bytes; supply `1000000000000000` base units; metadata immutable;
  mint/freeze revoked; exact custody verified; lease consumed. No campaign created.

Unit orchestration tests use a synthetic signer boundary; the validator rehearsal
provides the actual cryptographic and account evidence. Neither establishes hosted
load capacity or production readiness.

## Ultimate-goal check

Improves verifiable funds and restart recovery without touching old programs.
Does not yet finish the creator journey, hosted scale qualification, independent
audit or release gates. Those remain open in the controlling implementation plan.
