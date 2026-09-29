# Wallet-signed localnet claims

Registered launched localnet pools support participant tokens, excess SOL refunds, both parent snapshots and vested dev tokens through `POST /api/account/postlaunch/claim/prepare` and `/submit`. These endpoints require a wallet-authenticated session and CSRF token, and never sign using server keys. They remain restricted to the registered active campaign after confirmed phase 3 or the explicitly selected qualified rehearsal. The active funding window is unchanged; this does not enable mainnet.

Preparation accepts `campaign`, `action` (`participant`, `refund`, `parentA`, `parentB`, `dev`) and a unique `requestId`. It checks current entitlement and returns the owner, campaign, mint, program, genesis identity and unsigned transaction. The wallet pays network fees and any required token-account or parent-receipt rent. Submission accepts `intentId` and `signedTransactionBase64`; `local` is rejected. The original operator-only direct local claim endpoint is unchanged.

The browser validates the exact canonical account addresses and claim instruction before prompting. The server verifies the raw compiled message and wallet signature, allowing only the existing bounded wallet compute-fee additions. Intents are bound to request terms, owner and local ledger/program identity. Signed bytes reach the durable single-writer journal before broadcast. Transport retries and process restarts reuse those bytes and reconcile the original signature. Requests resolve their bound campaign address; an active launch cannot retarget a prior rehearsal intent. A changed registered campaign fails closed. Unsigned requests expire after three minutes; signed ambiguous outcomes must be reconciled, never silently replaced.

Verification:

```sh
node --test test/claim-intents.test.mjs
node verify-external-claim.mjs
```

The three focused tests cover all five browser instruction shapes, destination/program/extra-instruction tampering, wrong owner/signature, request-term reuse, ledger changes and restart recovery after an ambiguous send. The real localnet check signs outside the service with the funded fixture dev key, verifies receipt/balance increase and identical replay signature with no second payout. This verifies the external-signature protocol; an actual browser wallet extension claim has not been exercised. No real funds are involved.

`GET /api/account/postlaunch` and `#shart-live` select only the active campaign after launch. Before launch they expose no pool or claims. `GET /api/account/postlaunch-preview` and `#shart-preview` select the separate rehearsal explicitly. Live confirmed account state, program binary/genesis, immutable terms and canonical pool configuration are validated. Historical transaction metadata can be unavailable on a pruned ledger; the interface reports this without inventing a receipt. Pool fee counters come from that campaign’s own program-owned fee PDA.
