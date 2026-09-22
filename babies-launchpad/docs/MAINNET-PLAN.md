# KIDS mainnet plan (owner decision, 22 September 2026)

Owner: "reuse Pairz services, use the Helius RPC, create real treasury and dev wallets (I save the keys), do the
mainnet snapshot, get the programs on mainnet." Audit is the owner's track and runs in parallel.

## Steps

1. **Network profile** (`localnet/network.mjs`, `KIDS_NETWORK=localnet|devnet|mainnet`). Every ledger assertion and
   every label on the site follows the profile. Manifests carry a label, never the RPC URL. Done in code.
2. **Keys** under `~/.config/kids/mainnet/` (mode 0600, never in the repository, never printed): program keypair
   (the program id), operator keypair (keeper and campaign creator; hot key, funded by the owner), dev wallet,
   treasury (already `91eLwFTAxkcQLPSMxbzdSFkTyEwyRYcoZk64HMZj8vX`). Addresses go into `deployment/MAINNET-IDENTITIES.json`.
3. **Program deployment tool** (`localnet/atomic-launch-deploy.mjs` under the profile): deploys the reproducible
   CI binary `ef584ae7…8923`, writes the program manifest with lineage. Devnet first with faucet SOL, then mainnet
   with owner-funded SOL (about 3 SOL rent plus fees).
4. **Mainnet parent snapshot** (`localnet/snapshot-parents-mainnet.mjs` through Helius): evidence files, Merkle roots
   and eligible totals per parent, 2 % cap, confirmed exchange exclusions. Imported into the campaign at provisioning.
5. **Campaign provisioning on mainnet**: coin mint, escrow, parents configured from the snapshot roots. Terms from
   the same environment variables as the test ledger (defaults 100 SOL soft, 500 SOL hard, 24 h).
6. **Hosting**: a new Railway project `kids-mainnet` with `kids-api` (API and keepers, no validator, volume for
   journals and backups) and `kids-signer` (operator key). Helius URL copied server-side from the Pairz service.
   Vercel gate pointed at the new backend by its `KIDS_BACKEND_ORIGIN` variable (owner).
7. **Devnet rehearsal** of the whole lifecycle with real wallets before any mainnet step that costs money.
8. **Mainnet**: program deploy, snapshot, first campaign with a small soft cap, keepers watched, then public.

## What stays with the owner

Audit, upgrade-authority decision (default: operator key on his Mac, moved to a multisig later), moving the treasury
key to hardware custody, funding the operator key, Phantom whitelisting, and the Vercel variable change.
