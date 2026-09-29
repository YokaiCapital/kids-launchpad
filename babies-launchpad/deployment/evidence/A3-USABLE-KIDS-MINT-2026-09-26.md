# Usable encrypted vanity mint, 26 September 2026

`node localnet/mints/qualify-inventory.mjs` exercised the existing vendored
generator, encrypted inventory and asset-signing capability on the isolated v2 ledger.
No generator, encryption format or signing implementation was rewritten. Ordinary
mint fallback is disabled. The run uses four existing native generator processes and
stops at the first available address, with a ten-minute upper bound.

Result: **passed**, 83.992 seconds including finality. The new address is
`9TRc2kt6hP1JYF2niDGQjrGGFfoJGHpHuYpgHwDnkids`.

The test reserved it with the strict lowercase-suffix validator, persisted its signing
intent, obtained a signature for an independently reconstructed creator-approved v0
message, reopened the inventory and recovered the identical signed transaction.
A foreign reservation and altered message were refused. A signed mint could not be
returned to stock. The complete packet was persisted before broadcast.

The actual local validator accepted the 521-byte transaction. At finality it reports
1000000000000000 base units, six decimals, mint authority null, freeze authority null,
and the complete supply in the derived launch-authority token custody. The lease is
consumed and retains the finalized signature across a fresh registry connection.

- Genesis: `7Sxh5h588K957C1to4Pvx6zQY6CLpghPCeG3ZeyrZJef`
- Program namespace: `C92rDge6sQFBcWetywn3NgHRXQUiqZenr2cG1guwRxYE`
- Signature: `4GCXs6wQ528CmEvCt97YLbEd6ATMB27EXQV7pGvXXnr9PNb4McRZNJXiYxrDgBtcYHsUZqgH34uUynp6cdXW35Tv`
- Custody: `8bFpbxx48kzDytHcShentUyLPLgwZfzPvNAwBNpgpDMC`

Mutable test inventory, encryption key, approved packets and report are stored only in
a new private OS temporary directory. No mint private key is exported by the signer,
printed or added to Git. These test keys are unrelated to any production inventory.
Log: `/tmp/kids-mint-qualification.log`.

## Exact scope

This proves an actual `kids` key can be generated, encrypted, reserved, signed after
restart and used to create a fixed-supply mint. It does not certify a production fleet,
inventory throughput/stock capacity, hosted signer availability, metadata publishing or
the full creator flow. No campaign account or pool was created by this particular test;
its derived custody is an isolated test artifact. Existing live programs are untouched.

The asset signer is a server-only capability. Its production authorizer must reconstruct
from durable trusted plans, require creator approval before signing, enforce current
leases and reconcile prior generations. Never expose arbitrary packets/messages to that
callback or mistake its generic capability for a complete public-launch authorization.

Ultimate-goal comparison: closes the difference between stock count and usable mint-path
evidence, while leaving complete A3 funding/provisioning and release gates explicit.
