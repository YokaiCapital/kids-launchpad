# A39: funding-first launch through the hosted signer composition (isolated ledger), 29 September 2026

Run 11 of `localnet/protocol-v3/funding-first-signer-localnet.mjs` on the isolated v2 rehearsal ledger (RPC 127.0.0.1:19199,
program 2T1K7xegEghMfR5RxtpJurG5bQhesHK6y8cvhpSos7CV, build 6236f4e8ee6cd003779469a4ca098bb16c73a97650969949d2617b045ad54755),
with the production signer composition scoped locally: distinct creator (the program's pilot creator), keeper (a fresh key held by
the v3 registry signer service), treasury (the program's sealed localnet treasury, never a signer). 19 checks, 0 failed.

Facts (from the evidence file `funding-first-signer-rehearsal-11.json`, kept with the run logs outside the repository):

```
{"campaign":"BpkqxDkEPAckN3dMjT93KaeBaYhjS6qag5efWyiLSknA","table":"3gneEnKpUPU2Qm8fFPSv2Jt8cMo5gvjspEVdhAu2wVyS","recentSlot":353069,"launch":"irkynwqYihMo3Lg4RdSVV9NUxKNUeuBitX7gZqCoxqBQPiJmNTgnWGaTJDtMjB8Hqj7DHJChN1Szz6ecB4esg7w","fee":15000,"cu":333153,"loaded":"17+13","balances":35,"settled":["v3-lookup-table-rent=5740040","v3-lookup-table-rent=2232200","v3-funding-first-launch=28883560"],"balance":{"fundedLamports":"60000000","spentLamports":"36855800","returnedLamports":"0","heldLamports":"0","availableLamports":"23144200"},"verification":true,"checks":18,"timing":{"tableReadyAfterOpen":"38.4 s","tableAccountedAfterOpen":"38.4 s","deadlineToLaunchConfirmed":"17.7 s","deadlineToLaunchFinalized":"17.7 s","deadlineToAccounted":"17.8 s"},"passed":19,"failed":0}
```

Timing correction: the `timing` block above measures from the harness's finalized-clock gate (deadlinePassed 00:43:14.019), which is
NOT the sealed funding deadline (00:42:54.000). From the sealed deadline, launchConfirmed 00:43:31.751 is 37.8 seconds, of which
about 20 seconds were the harness waiting for the finalized bank's clock before sending. Run 11 is an execution and accounting
qualification, not a speed result; run 12 sends as soon as the confirmed chain clock passes the sealed deadline and reports
elapsed times from that sealed deadline.

What the run proves, in order: opening (tag 41, creator + reserved mint + reserved fee NFT co-sign) with record byte 992 = 2;
a participant commits; the creator's real funding packet is finalized and credited to the campaign's operating budget from its
finalized evidence; a durable table plan (creation slot from SlotHashes); the keeper's lookup table created and extended through the
signer's capability path (two packets, the second only after the first finalized), settled from finalized evidence at exactly rent;
the table finalized, complete and warm before the funding deadline; after the finalized chain clock passed the deadline, the tag-42
launch through the table, signed by the service (real budget, real cost reader, pinned resolution proved on the ledger), landed with
three signatures; campaign live; the version-2 live verification passed; the launch's finalized meta.loadedAddresses equal the pinned
resolution; the launch hold settled at exactly the fee plus eight rents plus the Metaplex creation fee; no held lamports remain.

Not proven here: the hosted lifecycle for version-2 records (no job scheduling in this run), custody of the reserved mint and fee-NFT
keys until launch, refunds/claims for version 2 (tags 43 to 47), and anything on mainnet. Not deployed.
