# Deployment verification

## Current scope

There is **no mainnet launch, deployed Shartcoin pool or LP lock**. Configured localnet commitments transfer test SOL to program-controlled escrow; the API and UI read chain balances. Both commitment escrow and dev vesting are deployed on the isolated local validator. Local mint labels do not identify the real parent tokens.

[`deployments.json`](deployments.json) is the machine-readable registry. It includes only public chain identifiers; private keys and operational configuration are excluded. A fresh local setup generates different addresses and a different genesis hash. Do not expect the example deployment to exist on another machine.

## Current localnet deployment

| Item | Value |
| --- | --- |
| Dev vesting program | `HV3Bo9fEdmToXMhFCoXAaDee8nk4NVspyuCzgN5vQPWZ` |
| ProgramData | `Ej7hBaEp5NUWX3XhpsjJ8MbX8u6MNpCWuT4Q9k16pZuM` |
| Upgrade authority | None, confirmed from local validator |
| Last deploy slot | 7747 |
| RPC | `http://127.0.0.1:18999` |
| Genesis | `BdKFesSjNS8AMEvF1VWjs5946Nh6Vn2PK3EcSFuJRobW` |

Source: [Solana Foundation rewards](https://github.com/solana-foundation/rewards/tree/aa1cfd9276375e44e57d1917d110ff095fb6d475), pinned commit `aa1cfd9276375e44e57d1917d110ff095fb6d475`. The deployment script changes only `declare_id!` and deploys with `--final`. The upstream MIT license remains with its source. This is not a claim of an independent security audit.

## Check against the running local validator

```sh
solana genesis-hash --url http://127.0.0.1:18999
solana program show HV3Bo9fEdmToXMhFCoXAaDee8nk4NVspyuCzgN5vQPWZ --url http://127.0.0.1:18999 --output json
```

Confirm the genesis, program owner, ProgramData and absent upgrade authority. The checked local binary SHA-256 is `440548a15b51c96b37998ccb80ff0300fa00177422600241d30a73690c6479cc`. This is a build artifact checksum, **not independent reproducible-build verification**. Deployment-account padding and toolchain differences must be accounted for before claiming byte-for-byte on-chain equivalence.

To build a new local deployment, follow the root README, then run `node babies-launchpad/localnet/deploy-rewards.mjs`. That creates a new local program ID; update your own deployment registry from public output. Never copy another deployment's secret key to reproduce an address.

## Dev allocation

Three percent of total supply is allocated to the dev: 1% timestamp-gated at test launch, 2% linear over three UTC calendar months with no cliff. Distribution roots bind recipient, quantity and schedule. Revocation is disabled; the clawback timestamp is maximum i64. On-chain test coverage includes early claim, wrong recipient, changed schedule, excessive claim, partial payout, attempted early clawback, final payout and duplicate claim rejection.

The current timestamp is provisioning time, not a production pool-launch event. Standard SPL test mint authority remains present; local vesting immutability does not mean the test mint or the whole launch system is immutable.

## Public launch release requirements

Before accepting real funds, publish the network, genesis, escrow program ID and source commit; reproducible build evidence; all authorities and upgrade controls; escrow and token vault derivations; verified parent and child mints; pool and LP-lock addresses; fee recipients and split; supply and vesting records; cap conversion/price-lock rules; deadlines and failure refunds; and transaction signatures proving launch and authority changes. Verify them against chain state, not only this file.

Commitments must go to program-controlled escrow. The dev must not have an unrestricted withdrawal path. Oversubscription allocation and refunds must be enforced by the program. The current localnet escrow enforces these fund-custody and refund requirements. Pool creation, launch settlement and token allocation remain unfinished.

## Localnet commitment escrow

Program `CvWEQN6NZcEkYUZtYmtUy65wh8o4Fo9L6E8jGsRNjhiN` is immutable on the recorded localnet. Source is `programs/commitment-escrow/src/lib.rs`. Campaign PDA seeds are `campaign`, creator public key, little-endian u64 nonce. Receipt seeds are `commitment`, campaign public key, participant public key. There is no admin withdrawal instruction.

After funding closes, below-soft-cap campaigns permit full refunds. Over-hard-cap commitments receive proportional accepted amounts and excess refunds. A permissionless keeper pays transaction fees to send refunds only to each recorded participant. If launch is not completed by its deadline, remaining principal is fully refundable. **This version has no AMM launch adapter: accepted funds stay escrowed until the timeout refund.**

Run `node babies-launchpad/localnet/deploy-escrow.mjs` to build/provision an isolated deployment and `node babies-launchpad/localnet/verify-escrow.mjs` for chain tests. The verifier makes a 0.001 test-SOL commitment to the configured campaign and creates short-lived refund fixtures. Sixteen checks passed, including pre-funded PDA handling, replay rejection, timing, receipt isolation, exact proportional refunds, full failure/timeout refunds, signed-message tamper rejection and idempotent submission. Build checksum is recorded in the registry; this is not independent audit or reproducible-build certification.


## Separate v3 combined rehearsal

The local UI now commits to a persistent v3 campaign, with legacy v1 refund-only access retained. The upgradeable v3 program on `http://127.0.0.1:19099` now implements participant and parent claims, launch-triggered dev vesting, campaign-owned Fee Key collection, child-fee conversion to WSOL, cumulative fixed-recipient routing, and atomic parent purchases/burns. Its current 177,880-byte binary SHA-256 is `e0b4051752422366e51ae6a5fe8eaeeeab773faa1448cec33a0990961c76e71d`.

The same-campaign combined localnet reports passed 26 launch/claim checks and 9 fee checks. See [qualification and remaining gates](LAUNCH-QUALIFICATION.md) for evidence and reproduction, and [fee settlement](FEE-DISTRIBUTION.md) for actual WSOL accounting. Parent roots still trust their publisher; canonical index-2 parent pools and creator-authorized keeper execution are required. The active campaign uses this v3 program; its 24-hour operator launch is not yet executed, and no mainnet deployment is qualified.

The current `e0b4051752422366e51ae6a5fe8eaeeeab773faa1448cec33a0990961c76e71d` binary also passed five on-chain failure/recovery checks: below-soft-cap full refunds, missed-launch timeout after a partial refund, commitment sequence validation, refund replay protection, and premature-refund rejection. Run `node localnet/atomic-failure-verify.mjs` after the atomic launch fixture.
