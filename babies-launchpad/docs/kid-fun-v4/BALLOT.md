# Full ballot: hundreds of submissions, one daily winner

User-confirmed correction: all approved entries in a round compete. The earlier three-card example and five-candidate cap are superseded. No hidden platform shortlist. Public launches and voting are still closed; the screen uses illustrative data.

## Browse

Heading: **Pick the next kid.** Under it: round ID, actual candidate count and absolute cutoff. Display This round / Upcoming / My submissions.

Search kid name, ticker or parent; parent filter; Discover / New / Most voted sort. Search covers the entire round on the server, not just loaded cards. Candidate total and filtered result total remain distinct. Clear filters is always available. A failed search is not “no candidates.”

Desktop: three columns of compact cards plus a sticky Your vote panel. Each card contains unique art, name/ticker, two parent identities, KID voting power total, View proposal and a radio selection. Pagination makes the full size visible. The mock uses nine per page for legibility; real page size can be tuned without changing eligibility.

Mobile: one-column compact rows with portrait, name, parents and total; filter sheet; selected candidate and Review vote fixed above bottom navigation. Preserve safe area and scroll clearance. Show current result count and page position. Do not shrink a desktop grid until text is illegible.

## Ordering without a hidden shortlist

Discover order is a reproducible shuffle seeded from the published round seed and a stable public wallet identifier, or session seed for anonymous browsing. Candidate IDs, seed and algorithm version are available for audit. No secret scores, paid boosts or administrator-selected featured winners.

Keep this ordering stable across pagination, back navigation and live total refreshes. Switching to Most voted is explicit; refreshes must not move a selected card under a user's pointer. Ties use deterministic candidate ID ordering. New uses freeze-entry timestamp and stable ID. Ordering changes browsing only, never tallying.

Per-viewer order varies exposure but cannot guarantee equal attention or prevent campaigns, direct-link traffic or session reseeding. Do not market it as proof of fairness. Measure candidate impressions and proposal opens during the pilot to detect persistent visibility problems.

## Vote from anywhere

Selection persists through search, sorting, pagination and proposal detail. Your vote shows **Selected — not submitted**, the candidate, personal snapshot power and Review vote. After acceptance it shows **Vote recorded** with receipt and Change vote. If current filters hide the selected candidate, show a link back to it; never silently clear it.

Proposal links include round and immutable proposal ID so creators can share their entry. Direct links open detail, not a signing prompt. Review always shows the current round, frozen candidate version and cutoff. A link to a past round opens its result and cannot vote in a new round.

The round freezes before opening. Upcoming entries never steal exposure halfway through a live vote. No artificial first-come voting cap. One accepted choice per owner, weighted by snapshot KID, remains the rule. Users may replace it before close. All approved candidates share the same economic preset.

## States to validate later

- 248 entries: page totals and search agree; a candidate on the last page can win.
- Search for an off-page ticker: returns its proposal without losing selection.
- Filter hides chosen candidate: Your vote remains intact.
- Vote total updates: no card order jumps in Discover.
- Navigate back from proposal: restore page, filter, scroll and selection.
- Upcoming candidate: clearly not eligible for current ballot; no vote button.
- Approval after freeze: next-round status with reason and timestamp.
- Network error: previous results remain labeled stale with retry; not an empty ballot.
- Candidate disqualified: frozen evidence retained, clear status, votes handled by published failure policy; never secretly substitute another candidate.

These are UX acceptance criteria, not implemented or tested application behavior.
