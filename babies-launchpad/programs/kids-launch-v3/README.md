# KIDS launch v3: terminal setup-budget return

**New-program candidate, localnet only. Not deployed or enabled for production.**
This crate compiles the existing v2 handlers as a library under a separate program ID.
It does not upgrade v2 or add rights over any existing campaign. Its Cargo.lock keeps
all v2 dependency versions and checksums; only the new root package is added.

## What changes

- New creation is restricted on chain to pilot creator
  `JBjY3ETQWkJa79G1URqFsgzqxKqxWeNfNycccQLkGVgn`. User commitment,
  claim and refund access is not restricted by this creation gate.
- Instruction 27 returns remaining **native setup SOL** from the campaign's
  `launch_authority` System PDA to the immutable creator recorded in its terms.
- Return is allowed only after the campaign is `LIVE` or `REFUND_ONLY` on chain.
  A below-minimum or timed-out launch must first be finalized. A settled but
  unlaunched campaign still needs its setup budget and cannot return it.
- Anyone can pay the transaction fee; nobody can change the destination. No
  operator, dev or treasury recipient is accepted in place of the creator.
- Repeating a zero-balance return succeeds without another transfer. Later
  unsolicited donations to this PDA also belong to the recorded creator.

## What does not change

Standard supply split, vesting, cap/settlement math, paid refund/claim rights,
AMM fee validation, permanent LP lock and fee routing reuse v2 unchanged.
There is no Direct liquidity recycling, reserve sale, parent-claim activation or
Auto MM here. New Family creation remains refused.

The return takes no token account, receipt, fee vault, LP or pool account. The
participant SOL campaign account is read-only. Its rent and unpaid refund
liability remain intact. Launch- and fee-authority PDAs are separate. Releasing
setup SOL does not release token custody or locked liquidity.

**Not every creation cost is refundable.** Network fees, the AMM creation fee,
consumed rent, storage/metadata charges and any separately disclosed platform
charge are expenses. This instruction returns only the native SOL still present
at the setup authority. It does not close accounts or refund their rent. Any
sponsor funding this address accepts the fixed creator return destination.

Funding must follow successful creation in the **same transaction**, so rejected
creation cannot strand a setup transfer at an uninitialized campaign's PDA.
Do not send creator budget in advance to an address for a campaign that does not
exist. Mint/media preparation has separate irreversible costs; quote them clearly.
The accepted commitment itself must never be counted as setup funding.

## Wire format

Program version **3**, account layout version **2**. Existing campaign/receipt/fee
magic and economics use the v2 codec. The **program ID and manifest version**, not
layout version alone, select the adapter. Existing v2 capabilities must not be
relabeled v3 or extended to permit instruction 27.

Tag `27`, followed by the campaign's 32-byte genesis value; exactly four accounts:

| Index | Account | Permissions |
|---|---|---|
| 0 | Canonical campaign owned by this new program | read |
| 1 | Its `launch_authority` PDA, System-owned and empty | write |
| 2 | Sealed creator | write |
| 3 | Executable System program | read |

No signer account is required by the instruction. The outer transaction still
needs a fee payer. Errors: 100 nonterminal campaign, 101 wrong setup account,
102 creator outside pilot; v2 network/owner/terms checks retain their errors.

## Reproduce locally

Use the isolated v2 rehearsal ledger already described in `localnet/`:

```sh
cargo test --locked --manifest-path programs/kids-launch-v3/Cargo.toml
node localnet/deploy-kids-launch-v3.mjs
KIDS_REQUIRE_LOCALNET_TESTS=1 node --test localnet/test/protocol-v3-setup-e2e.test.mjs
```

The deploy script requires loopback RPC with the exact genesis of the local v2
manifest, uses a separate program key, and records binary hash and zero stack
frame overflow warnings. Test-only features bind the pilot/treasury to isolated
local keys. Never use those features in a production build. Generated keys and
manifests remain ignored; no secret belongs in source, logs or public artifacts.

## Remaining release work

This is one custody prerequisite, not a completed public creator flow. Versioned
registry/signer/job/API/UI adapters, exact funding plan, durable mint/media
provisioning, external-wallet recovery, setup/ongoing cost qualification and
independent security review remain required. Public presets and funding remain
disabled. A separately reviewed production manifest and binary must bind a new
program ID. No production program ID is asserted by the local test evidence.
