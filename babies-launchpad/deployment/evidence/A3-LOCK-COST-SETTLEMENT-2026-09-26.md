# A3 finalized lock-cost settlement — 26 September 2026

Status: isolated v3 cost attribution qualified. No hosted signer, funding policy,
worker activation or public release is enabled by this change.

The reviewed cost model reconstructs the exact 29-account launch instruction and
compute limit from trusted sealed terms, payer, fee NFT and blockhash. Additional
instructions, account aliases or changed identities are refused. It attributes
only the keeper's four lock-account rent top-ups and the actual network fee to
the operating budget. The campaign's accepted SOL and the authority's pool-setup
reserve are separate. Metadata is not created by this launch template.

Negative rent, unexplained income, unexpected account movement, above-ceiling
cost and non-atomic failed execution refuse settlement. Unknown outcomes retain
the full hold. Finalized settlement is idempotent; actual cost is charged once.

## Actual local-chain evidence

`localnet/creation/qualify-operating-lock.mjs` created a fresh isolated campaign
and pool on the pinned v3 validator, using the existing Raydium clone. It checked
the deployed program binary before creating any transaction. A separate test
operating payment was credited only after finalized proof. The signed launch
packet was saved before broadcast and its exposure held before sending.

- Campaign: `2xkfcfcgKpUtGPf8S9jgpPnepEV3btiMj86pw3JqAW2D`
- Mint: `5s3pPGVrxvRdqLNavSLGUc9J7AFDgqRGwAu9LxoxWpRj`
- Funding: `5vsRwbyr4acM3LMqNPKnEdK2k97MtB2F3XLfKq5WmjDA3aetncQ7iutKQo7WrJKTfpySCJsPZK7tsQtpg1ztk38c`
- Lock launch: `4XKFVJfWz5qJxHamStWFus44r4T9pkGqKWz9VkMVFFpDkfzHGVWSGNVHLiJmQsaoR8dfgubddkGPLVBjQsZPSLK8`
- Versioned packet: 1,201 bytes, no address lookup table.
- Actual keeper rent: 8,212,800 lamports; actual network fee: 10,000 lamports.
- Unused metadata rent allowance released: 5,616,720 lamports.
- Remaining operating budget: 11,777,200 of the test's 20,000,000 funded lamports.
- Participant refund liability preserved: 1,000,000,000 lamports.

The existing full launch verifier passed: correct pool/vaults, locked liquidity,
fee NFT custody, mint/freeze authorities revoked, retained claim custody and
refund solvency. The metadata account was absent as required. Duplicate
reconciliation did not charge again. The fresh fixture uses 2% clone fees and
small test caps; no production preset changed.

The bounded regression passed **448 tests, zero failures and zero skips**.
Tests include failed-transaction accounting, prefunded accounts, extra instructions,
rent bounds, changed AMM/lock/mint/campaign and unauthorized balance movement.

## Ultimate-goal comparison

Verifiable money and permissions improved with actual nested-CPI cost evidence.
Overall readiness remains partial. Signer coupling must make these holds mandatory
before issuing signatures, with durable recovery after interruption. Hosted payer
funding/subsidy policy, remaining account-creation templates, independent workload
qualification and release gates remain open. Existing funded coins are unchanged.
