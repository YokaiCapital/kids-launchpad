# Fixed pilot voting and submissions design

Design policy for review, not an implemented voting system. No permission to spend funds or launch is implied. KID holder control starts after platform-selected genesis.

## Rules users see

**Pick a kid. Review. Sign your vote.**

- One KID at the round snapshot gives one vote unit.
- One active choice per wallet owner. Change it before close.
- At least 5% of eligible snapshot power must participate.
- The highest valid vote total wins, subject to published launch checks.
- A tie or failed round means no launch in that slot.

All defaults below are fixed for the proposed pilot and published before a ballot opens. A rule change creates a new future rules version, not a mid-round change.

## Schedule

12:00 UTC submission review cutoff. 16:00 current ballot closes. By 17:45 next candidates are frozen. 17:55 finalized KID snapshot. 18:00 current elected launch slot and next ballot opens. Next ballot closes at 16:00 the following day. Every screen says “next launch” rather than promising tomorrow incorrectly. Display absolute dates/local equivalents in the actual app.

Genesis must finish early enough for a real electorate to exist. Otherwise defer the first holder round visibly. No invented votes or insider placeholder electorate.

## Submission selection

Submission is free in the product design; network signing is a message. One active queued proposal per submitting owner is a rate limit, not proof of unique people. Content and mint-pair duplicate checks catch obvious spam; public moderation reasons and a single appeal path provide accountability.

Moderators check compatible mints, distinct parents, usable image, rights declaration, deceptive metadata and publishable immutable terms. They do not promise returns or pick winners after voting. Review decisions use standard reason codes with actionable text.

Every valid submission approved before the published freeze enters that round. Hundreds may compete; there is no capacity-based shortlist, five-slot limit, paid placement or popularity gate. Approval determines validity, not editorial preference. Review order is FIFO with published status and reason codes; unresolved or late submissions are shown under Upcoming with their actual status, never silently lost. The review cutoff does not guarantee approval. Publish review backlog and deadline expectations.

A losing proposal may re-enter after one complete round, with a new version if edited. A rejected proposal can be corrected immediately, preserving the review trail. Owners explicitly reconfirm entry; do not recycle abandoned submissions indefinitely. Candidates added after a ballot opens enter a future round, so every candidate in one ballot receives the same voting window.

Freeze name, ticker, parents, image hash, description, creator, launch preset, parent snapshot policy and rules hash. No silent artwork or contract substitution. If a winner becomes invalid, skip its slot; do not secretly award the runner-up.

## Snapshot and signed receipt

Aggregate token accounts by owner using finalized state and integer amounts. Publish snapshot slot, content hash, eligible denominator and excluded addresses/reasons. Exclude identified treasury/team, pools, custodial/program accounts under the published policy. Some related wallets may be unidentified; the UI must not claim all insiders are provably excluded.

Vote payload binds domain, chain, round, owner, proposal hash, snapshot hash, expiry, nonce and replacement sequence. Server acceptance validates every field, balance and cutoff. Atomic replacement prevents counting both choices. Idempotency makes retries safe. Public signed receipt log and independently reproducible tally expose accepted ballots.

This is operator-hosted voting with verifiable signatures. It is not trustless on-chain execution. Operator censorship and availability remain limitations. Show concentration separately from turnout; 1.25M KID voted is not 1.25M people.

Linear weighting does not reward wallet splitting. It also does not prevent borrowing, bribery or large-holder control. Do not add square-root weighting or per-wallet voting caps and pretend they solve identity. Publish top-holder concentration before ballot opening; changes to the voting model require new design review.

## Outcome policy

Quorum denominator is fixed at snapshot. One or more votes with no quorum is still a failed round. A unique plurality winner is elected after quorum, not automatically a majority of holders.

Tie: skip today's slot and schedule a runoff between tied leaders in the next round, with its own announced snapshot and unchanged candidate terms. Queued new candidates move forward in the published queue. Repeated ties remain skips; no operator tie-break.

Launch checks: final preset is already technically qualified before ballot opening; verify frozen proposal integrity, fresh parent snapshot validity, allocation plan and executor readiness after election. Parent eligibility is assessed separately at a finalized parent snapshot taken at ballot close, according to the published slot selection rule. If either parent has no eligible owners or required data is unavailable, skip; do not divert that parent's reserve.

Grace ends 18:30 UTC. A known pending transaction is reconciled by signature before any retry. A transaction may confirm after the target time; record its actual state, never call a confirmed coin nonexistent. No automatic second mint. Never create two coins tomorrow to compensate for a skipped slot.

## Acceptance scenarios for the later implementation

| Scenario | Expected outcome |
|---|---|
| Transfer after snapshot | No additional power created |
| Multiple token accounts | One aggregated owner balance |
| Repeated identical request | Same accepted receipt |
| New vote fails/rejected | Previous accepted vote remains |
| Signature returned after close | Late vote rejected |
| Wrong domain/round/proposal hash | Rejected without consuming valid prior vote |
| Snapshot unavailable | Round pauses; no fabricated power |
| Under 5% turnout | No launch |
| Top candidates tied | Published next-round runoff |
| Frozen image or parent changes | Launch stopped |
| Receipt omitted from public tally | Dispute and reconciliation before launch |
| Allocation snapshot has no eligible parent owners | Skip, no reassignment |

These are specified acceptance tests, not claims that the backend has passed them.
