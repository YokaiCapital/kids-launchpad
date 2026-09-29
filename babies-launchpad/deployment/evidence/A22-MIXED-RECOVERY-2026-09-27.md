# A22: mixed financial recovery and signer admission

This checkpoint is isolated localnet evidence. It does not authorize a hosted
deployment or qualify uninterrupted simultaneous-close capacity.

## Actual mixed recovery

The retained 100-pool ledger was used while another 100 campaigns settled and
launched at the canonical 2.5% configuration. Six independent worker processes
shared PostgreSQL and the existing durable signer journal. The final checks found:

- 100 new launches, 800 verified receipts and 100 verified permanent LP locks;
- exactly 100 SOL accepted and 100 SOL refunded;
- no remaining operating holds or unresolved signed packets for the new campaigns;
- 100 buys and 100 sells on the existing pools, all finalized;
- all economic-size fee collection, distribution and token-burn work drained;
- 0.013778081 SOL retained across fee vaults, below the existing minimum operation
  threshold per pool. Dust remains accounted for and is not reported as paid/burned.

Token residuals must be checked per mint with each pool's valuation. Summing raw
units across unrelated coins is not a meaningful aggregate and is no longer
emitted by the harness. This change does not modify the 500,000-lamport economic
operation threshold or any fee weights.

The synthetic trade driver initially exceeded the real 16-pending-action wallet
guard. That guard correctly refused; it was not relaxed. The driver now spreads
work across eight funded fixture wallets and reconciles at a 12-action watermark.
It retains owner bindings, approval requests, exact signed bytes and transaction
identities on resume. Bounded work stops launching new items after a failure and
drains in-flight tasks before closing its resources.

Because interrupted attempts required restarts, these results demonstrate recovery,
not fresh-close latency. The final completion pass started after closing and its
short queue samples cannot stand in for the whole run.

## Concurrent reads

During actual financial processing, 1,000 logical clients made three rounds of
directory requests over 64 persistent origin connections: 3,000/3,000 successful;
p95 749/662/662 ms, p99 776/687/688 ms. There was no per-viewer RPC fan-out.
This used 200 registered campaigns, warm shared views and local service-token
authentication. It does not qualify external wallets, 1,000 origin TCP sockets,
CDN behaviour or geographic latency.

## Signer capacity correction

Signer evidence reads now require an explicit PostgreSQL-backed RPC admission
channel in the v3 composition. Genesis, sealed terms, CPI rent, funding proofs and
operating-cost reads use that reserved channel. Congestion returns bounded 429
`signer-capacity`, preserving pending work; it cannot bypass approval or reserve
funding before evidence is available. Legacy v2 behaviour is unchanged.

The local fleet now allocates 180 RPC/s across six financial lanes, 30 interactive,
30 indexing and 30 signer evidence: 270 RPC/s of service allocations. Qualification
driver/bootstrap/verification probes are additional bounded test traffic, so this
is not described as a global provider ceiling. Hosted quotas remain to qualify.
The higher signer approval profile is still restricted to the pinned isolated
ledger; no production signing or hourly-spend limits were raised.

Validation: **687 tests passed, zero failures/skips**, including admission refusal,
no read/sign through congestion, scoped grants, terminal journals, restore integrity,
wallet invariants, worker isolation and bounded failure draining. Private reports,
packets, journals and fixture keys remain outside Git. A fresh uninterrupted
100-close + 100-active-pool run has been started and is a separate gate.

Against the ultimate goal, recovery and predictable upstream capacity improve.
Public readiness still requires fresh mixed-load results, operating-funding policy,
hosted provider/media/wallet qualification, externally anchored recovery and review.
