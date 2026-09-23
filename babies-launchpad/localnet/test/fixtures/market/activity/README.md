# Activity decoder fixtures (public mainnet data)

Fetched read-only from the public Solana RPC on 23 September 2026 with
`getTransaction(signature, {encoding:"jsonParsed", maxSupportedTransactionVersion:0})`
for the first mainnet test campaign `8LmwBAa5XquvtUrsKrvspfV6da9T7sHiXXMVDmEdYew`
(launch program `BLiaZWNQoPm4mG4cXNm4sXifFqs1Xmxx12qD9T4Y5NeN`, coin `8P47V2fj1yfg1C76YAZEXJBVzDJBFfURUUTeJjVJq5bz`,
6 decimals). `identity.json` is the decoder identity for that campaign (fee-state PDA derived with the program's
`fees` seed; the campaign recorded no distribution program, so the vault fields are null).

The campaign's whole history is 110 successful transactions: tags 0+9, 1 (twice), 2, 4, 6, 20, 21 (34), 22 (12),
23 (18), 24 (32), 7 and 26 (6). No refund, ready check, dev claim, parent claim, Jupiter buy-burn, distribution
instruction or failed transaction exists on mainnet for it; the tests build those cases synthetically from these files.

| file | signature (start) | what it is | exact executed amounts |
| --- | --- | --- | --- |
| campaign-init-configure.json | 4oKFHP34 | tag 0 (campaign created) and tag 9 (parents configured) in one transaction, legacy version | no assets |
| commit.json | 2ZxBhwyu | tag 1: a participant commits | 1000000000 lamports into the campaign (the receipt rent of 1219200 is not a commitment) |
| finalize.json | 4Kir4dfk | tag 2: the keeper finalizes the round | no assets |
| settle.json | 2F2SEixM | tag 4: one receipt settled | no assets |
| launch.json | 4x6SEETK | tag 6 (v0 transaction): pool created, LP locked, mint and freeze authorities revoked | 2000000000 lamports and 435000000000000 raw coin into the pool vaults, 932737905208 LP into the lock; two `setAuthority` to null |
| fees-init.json | 4ZdPxfrN | tag 20: fee state created | no assets |
| fees-collect.json | 3sTyKZB1 | tag 21: CollectCpFees -> CPMM withdraw into the fee custody | 37682365 raw coin and 46 lamports in |
| fees-sell.json | 4k4e4CgZ | tag 22 (retired on chain, present in history): coin-side fees sold for SOL | 680679622633 raw coin out, 3452881 lamports in |
| fees-distribute.json | AridR2H8 | tag 23: WSOL to the treasury and dev associated accounts | 3996882 lamports to the treasury, 815690 to dev |
| buy-burn.json | 5rn1vdog | tag 24: parent A (Fartcoin) bought on the CPMM pool and burned | 1019612 lamports out, 6928 raw Fartcoin burned |
| claim-participant.json | jWkQHbvw | tag 7: participant claim paid from launch custody (ATA created in the same transaction) | 435000000000000 raw coin out |
| burn-child.json | 3iFTQBFj | tag 26: coin-side fees burned | 670345318218 raw coin burned |
