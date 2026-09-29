# A3 browser creator review and recovery

Isolated implementation checkpoint; not hosted, mainnet, external-wallet or public activation evidence.

The local-only wizard can save a draft, request and accept its exact expiring setup quote, resume the same accepted request from My launches, and review each creator transaction separately. The accepted review accompanies read-only flow status. The browser independently reconstructs all six mint instructions, native custody setup and all 800 sealed campaign bytes plus its exact setup transfer. It rejects different supply, recipients, fees, schedule, authority operations, extra transfers and wallet message changes. This is separate from legacy transaction validation.

The controller binds request, draft, creator, mint, campaign, original quote and per-stage offer. Account changes/disposal stop submission. A lost submit response retains the exact signed packet in that tab; resubmission cannot ask for a second signature or create a new request. Reload uses the wallet-owned accepted draft. Status reads do not sign or broadcast. Each new approval is explicit. Registration remains distinct from worker activation and participant funding.

Access: the entry is development-only, loopback-only, localnet-only and requires `VITE_KIDS_CREATOR_REHEARSAL=1`, the existing pilot/session and explicitly composed backend services. No hosted creation service is mounted by this change. Production creation remains disabled.

## Evidence

- 419 tests passed across registry/jobs, creation, signer, wallet, market, security and pilot/account integration. The nine new browser packet/controller tests cover all three stages, policy/packet mutations, ambiguous HTTP, double clicks, refusal, owner changes and disposal. Later UI copy/controller freshness changes passed the nine focused tests again.
- Normal and public-launch-enabled production builds passed. Publication pattern scan: 827 export files, zero findings; this is not a guarantee of absence of secrets.
- Browser plugin unavailable; Playwright with headless Chrome used an isolated Vite component harness at `http://127.0.0.1:4323/__creator-ui`. Creation prepare → independently checked review, addresses expand, status refresh and quote acceptance callback passed at 1440, 768, 390 and 320 pixels. No horizontal overflow or page errors. This component harness mocks HTTP data and is not real-wallet qualification. Initial harness import/preamble errors were fixed before the successful run.
- Real SBF/local-validator rehearsal used the browser controller for native custody and campaign approvals; test-key signing stayed in Node and was restricted to the exact offered message. Existing mint inventory and mint execution were real; publication receipts and cost input were explicitly synthetic. No external metadata was uploaded.
- Local mint: `FvKR5s6SCJ76hVWCXsQL5bKn95SdUwnrp72kj9aHkids`.
- Campaign: `5yc4F2stmi6VGE8ftxcTPsGQo4wDc6cBD1T71hvPAuJE`.
- Native setup signature: `5inghykXtYCqh5Yz5kDjjCdvkEaCzRMkmonfp4moj9ZokdPGm8DxpPcV9QBTCFeoXrf889y3UGV5BDgRSFxboBui`.
- Campaign signature: `hGNLxzDWo8LRKc6zPNkMQoLKxu3JKL8YBSNK9ih3HcgdeKkpQ5CXQMwxgJ5W4WsSkcPokjLx79dLvjs9jTQMEuS`.
- Delayed immediate opening recovered to generation 2; duplicate campaign funding rejected; exact authority reserve 260527992 lamports; one private registration; no worker activation. Chrome reported zero runtime errors.

## Goal comparison

Complete creator journey: **partial**, now has resumable browser review/approval and real validator setup evidence. External wallets, full wizard-to-authenticated-service rehearsal, video/hosted publication and complete operating funding remain.

Verifiable money/recovery: **partial**, exact messages and identity checks prevent substituted approvals; lost replies retain intent. The setup reserve is only for pool initialization, not all operating costs.

Public operating readiness: **not demonstrated**. Next: verified per-campaign operating funds, reservations and terminal accounting; then worker activation and mixed-load/failure qualification. Preserve current live programs and all paid claim/refund rights. No production deployment or public enablement occurred.
