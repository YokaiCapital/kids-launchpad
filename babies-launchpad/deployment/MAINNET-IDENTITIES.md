# Mainnet identities

`MAINNET-IDENTITIES.json` records the real-network addresses the owner supplied and what a chain read confirmed about them. Recording an address here does **not** deploy anything, enable deposits or make the launch terms final. The hosted environment still runs on localnet with placeholder mints.

Confirmed on 20 September 2026 from the mainnet mint accounts:

- **Fartcoin** `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump`: classic SPL Token, 6 decimals, mint and freeze authority revoked.
- **Buttcoin** `Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump`: **Token-2022** mint with embedded metadata, 6 decimals, mint and freeze authority revoked, no transfer-fee or transfer-hook extension. Every parent-holder read, buy and burn for Buttcoin must use the Token-2022 program; the desktop localnet rehearsal with a Token-2022 parent B passed on 20 September 2026 (ACTIVE-FEES.md). Its only market with depth is the canonical PumpSwap pool; the Raydium CPMM tier the program calls today holds no Buttcoin liquidity.
- **Dev wallet** `FvvCnPgyMrLCLVU6XvEsijFpyoJg65pp6CT3rP9WMxoi`: a valid ed25519 key with no on-chain account yet. Ownership is not proven until a message is signed from it.

Still missing: the treasury wallet, the dev-wallet ownership proof, and the cap conversion source. Snapshots of the two parent communities are taken with `localnet/mainnet-parent-snapshot.mjs` through the server-side Helius URL (`KIDS_HELIUS_RPC_URL`); see that module for the exact rules.
