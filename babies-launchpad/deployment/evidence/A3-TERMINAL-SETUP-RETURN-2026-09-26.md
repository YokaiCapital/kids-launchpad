# A3: isolated terminal setup return

Date: 26 September 2026. Localnet evidence, not a production activation or audit.

## Problem and scope

The reused v2 launch authority receives pool-creation setup SOL, but v2 has no
instruction returning its unused native balance. The public creator flow must
not promise a refund simply because an off-chain quote labels funds "unused".

Added `programs/kids-launch-v3`, a distinct-program candidate importing unchanged
v2 economic handlers with a new tag 27. It returns terminal setup SOL only to the
sealed creator. This does not introduce a discretionary withdrawal from a pool,
participant escrow, claims or fee custody. Existing program source is unchanged.

Public launch pilot creation is also enforced on chain for the owner-approved
wallet. Test builds substitute only a local test key through an explicit feature.
All v2 third-party dependency versions/checksums are preserved in the v3 lockfile.

## Verification

Five Rust tests cover terminal state, fixed destination, repeats, exact input
shape, foreign account ownership/PDA, altered terms, network binding, privilege
confusion and the on-chain pilot gate. Real SBF validator rehearsal separately:

- rejects a foreign creator and atomically rolls back a preceding setup transfer;
- rejects setup return during funding and after settlement before launch;
- creates a real Raydium pool and permanent LP lock through inherited handlers;
- refuses foreign destination, other campaign's authority, participant escrow,
  fee authority and wrong genesis;
- returns the unused live setup balance and failed-launch setup balance;
- proves paid participant SOL refunds and token claims still work afterward;
- proves repeat calls do not pay twice and terminal donations follow the fixed destination;
- verifies mint/freeze authorities are revoked and v2 rejects the new instruction.

The local tier is 2%, not a production 2.5% qualification. No hosted service or
production account changed. The new program remains upgradeable for local tests.
The test uses direct local keys, not the external-wallet/operator recovery path.

## Goal comparison

- **Verifiable money and permissions: partial, improved.** A previously absent
  on-chain unused-setup return now has a bounded implementation and local proof.
- **Preservation/recoverability: partial, improved.** No v2 source or program was
  upgraded; participant liabilities survive the return in the validator test.
- **Complete creator journey: partial.** Versioned adapters, provisioner, exact
  cost/funding/ongoing budget and actual-wallet creation recovery remain required.
- **Public operating readiness: not demonstrated.** Independent review, qualified
  production binary/manifest and capacity/pilot gates still apply.

Only the native balance remaining at the setup authority is refundable. Consumed
rent/fees, metadata and platform charges are not magically returned. Sponsors
accept the immutable creator as the return destination. Account-rent closure and
operational-budget reimbursement are not implemented by this instruction.

The next step is explicit version-3 adapter wiring without extending old program
capabilities, followed by durable creator provisioning and real-wallet rehearsal.

## Recorded local run

- Program: `2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV` (isolated localnet).
- Five v3 host tests and 68 unchanged v2 host tests passed.
- Mandatory validator test: 1 passed, 0 skipped, about 46 seconds.
- Live setup returned: 107,843,280 lamports; failed setup: 30,000,000 lamports.
- Participant refunds after the return: 1,500,000,000 lamports, plus the full
  participant token entitlement. All values are synthetic localnet amounts.
- Return signature: `2ptz4NAcA4bp7QxcgckrtHKUuw2r37P7xKoFafZj4nCjBbsdeRccT4EEtAC2PMrfHgZ4weLbXHxpjnhPfMAUw21g`.
