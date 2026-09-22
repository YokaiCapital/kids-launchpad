# kid.fun — design lock candidate

19 September 2026. Refines the selected black/lime direction and first alien. This is design work, not a deployed product. It supersedes v3 presentation. Public launches remain closed. Financial parameters require the qualification described in ECONOMICS.md before activation.

## The product in one breath

**Two parents. One kid. Holders choose.**

$KID is the permanent mascot and voting token. Genesis is the platform's pick. After genesis, people submit characters born from two parent communities; KID holders choose the next daily launch. There is one launch slot, not an endless feed of new coins. Older coins remain accessible.

The differentiator is a shared daily decision with fixed terms and recognizable characters. A large starting liquidity ratio supports that design; it is not a promise of price performance or the reason to hold KID. KID holders get selection rights, not dividends, guaranteed allocations or control over existing markets.

## Visual system

- Retain the first alien exactly: lime, oval head, two antennae, smug expression, small body. It is KID's identity only. No recolored KID pretending to be every child.
- Black #10110E canvas; #191D17 secondary surface only where needed; #D5FF3F primary action; #F3F4ED text; #A6AFA0 secondary text. Lilac is artwork/accent, not a second primary action.
- One grotesk sans family with bold editorial headings and one mono face for quantities. Desktop display 48/52, inner title 32/38, body 16/24, metadata 14/20. Mobile display 32/36. No distressed body fonts.
- Desktop 64px header, 32px page gutters, 24px section gaps. Maximum content width 1376px. Mobile 16px gutters, 48px controls. Corners 6px. Focus ring 2px ivory plus 2px offset.
- Lists use shared surfaces and rules. Do not put a border around every noun. No giant compliance banner; a quiet persistent Design preview label distinguishes demonstrations.
- $KID character is large on genesis only, small in navigation and rules. Candidate art dominates proposal previews; transaction review emphasizes the action and amount.
- A single image file per identity must be reused at every size in implementation. Generated mock variations are not separate approved character assets.
- Words accompany status color. Coin status and claim status are independent. Selected is not synonymous with voted, elected, launched or graduated.

## Navigation and content priority

Today / Vote / Submit / Archive. My allocations and wallet menu remain directly accessible. KID's mark links to its permanent coin page; the daily child never replaces the platform identity.

No creator dashboard full of financial settings. Users choose only parents, character, name, ticker and a short description. One fixed launch template governs the whole ballot.

| Surface | First thing understood | Primary action | Secondary detail |
|---|---|---|---|
| Today, prelaunch | KID is the first coin; nothing is live yet | Meet KID | How it works |
| Today, active | Which kid has today's slot and its actual state | View today's kid | Next ballot |
| Vote | Choices, personal snapshot power and cutoff | Review vote | Proposal / rules |
| Proposal | Character, parent identities, exact frozen terms | Select this kid | Evidence |
| Submit | Three short steps, no financial configuration | Continue / Submit proposal | Save draft |
| My submissions | Current status and next useful action | Fix, view ballot or view receipt | Published queue |
| Round result | Winner or reason no launch happened | View winner / next round | Tally receipts |
| Coin | Lifecycle, amount, executable quote | Review trade | Family / activity |
| My allocations | Eligibility and claim state for this wallet | Review claim when funded | Snapshot evidence |
| Archive | Older markets and round outcomes | Open selected coin | Search/filter |
| Launch rules | Fixed terms in ordinary words | Return to previous task | Technical model |

## UX contract

### Genesis and Today

Prelaunch says: “The first kid. Then you decide.” KID is platform-selected. No fabricated trading, wallet counts, deadlines, parent endorsements or live results. Vote and Submit destinations explain when they open rather than behaving like dead links. Parent identities remain undisclosed until actually selected.

Active Today features only today's coin at large scale and a compact next-ballot panel. Use “next kid,” never “tomorrow” when the winner launches that same evening. At 16:00, ballots close; the page switches to result/preparing. At 18:00, verified mint state determines the active market. Failed slots show why and keep the previous markets reachable. A scheduled slot is not a guaranteed graduation.

### Submission: Parents → Character → Review

Search by name or paste a mint. Show token name, chain, full expandable mint, and supply. Identity checked is not endorsement. Reject duplicate mints inline without deleting the other fields. Lookup failures remain retryable, not invalid tokens.

Character step accepts name, ticker, short description and PNG/WebP artwork, with a live preview and explicit rights declaration. Autosave locally. Mark success only after the data persists. Character upload failure must not discard parents or text.

Review displays parent identities, character and “Same launch rules for every kid.” Terms are one tap away before signing. Explicit message: “Your wallet signs a message. No coin is created.” Confirmation returns proposal ID and status, not a fake coin page.

My submissions always answers: Where is it? Why? What can I do now? Feedback specifies the actual issue and edit field. On-ballot proposals are frozen; editing creates a new future version, never rewrites votes.

### Voting

Every approved submission frozen into the round is eligible; there is no three- or five-candidate shortlist. The ballot supports hundreds of candidates. Show equal-sized character cards with name, ticker, parent identities, KID-weighted total and View proposal. The full ballot, not a curated featured section, is the default surface. See BALLOT.md for browsing and ordering.

Search by kid, ticker or parent; filter by parent; sort Discover (default), New or Most voted. This round, Upcoming and My submissions separate lifecycle rather than exclude candidates. Discover uses a published reproducible round/viewer seed, stable within a browsing session, to vary the first page across viewers. It is exposure rotation, not a guarantee of equal attention or Sybil protection. Pagination preserves query, filters, selection and position. Selection persists across pages; it never casts a vote on its own.

Selecting a row only selects it. Review shows candidate, round, snapshot voting power, cutoff, and whether this replaces an earlier vote. “Sign vote” is a message signature, never a token approval. Confirmation appears only after the server accepts and returns a receipt. Preserve the previously accepted vote if a replacement fails.

No wallet: browse then connect. Zero snapshot power: “No voting power this round. Your balance is counted at the next published snapshot.” Do not suggest buying will change this round. Wrong wallet: show current account and switch. Closed during signing: reject late vote, retain view of results. Offline: never pretend a ballot succeeded.

### Trading and claims

Main coin copy: “52 / 85 SOL raised.” Supporting label: “Moves to a Raydium pool at the target.” At target: “Pool opening”; only chain confirmation permits “Pool live.” Quote detail includes total fees, price impact, minimum received and expiry. Review remains unavailable until there is an executable quote. Preserve amount on errors.

Parent eligibility: “Hold at least 0.05% of either parent at its snapshot to qualify for that parent's allocation.” Show equivalent quantity, snapshot time and exclusions. Holding both is unnecessary. KID voting power and parent eligibility are separate.

Allocation lookup works without signing. Distinguish unavailable lookup, ineligible, locked, funding, claimable, pending, claimed and expired. Claims require a funded distribution. Show gross/net, network cost and actual deadline before signature. Wallet switches clear stale results. A submitted transaction is pending, not claimed.

### Mobile and accessibility specification

Same four navigation destinations in a bottom bar. Wallet menu exposes allocations and submissions. One-column candidate list with persistent selected-candidate review action above the bottom bar. Respect safe areas and scroll content clear of sticky controls. Review drawers become bottom sheets; eligibility and fees remain visible before signing.

Keyboard order follows reading order. Every field has a visible label; errors attach to fields and are announced. Modals trap focus, close on Escape, restore focus. Radio choices use actual radio semantics. 48px mobile hit areas. No hover-only terms, forced motion or countdown-only deadline. Display UTC plus local time. Contrast and 200% zoom must be measured on the eventual coded prototype; a raster mock cannot prove compliance.

## What makes the concept stronger

1. KID remains the recognizable permanent center, while a single daily child receives attention.
2. Parent selection is meaningful through transparent eligible-holder allocation, not an implied partnership.
3. Economic settings cannot be used to win votes with exaggerated return promises.
4. Rejected and losing submissions have explicit next steps; the loop does not end at rejection.
5. Archived markets, claims and historical decisions remain accessible after their spotlight day.
6. Skips are part of the product, preventing pressure to launch an invalid winner or fabricate demand.

No extra points system, paid boosts, staking promise, forced referral scheme or invented yield is added. Retention must come from character proposals and genuine selection participation.

## Review criteria before implementation

The design must answer without a tutorial: What is KID? Which kid is next? Who decides? What am I signing? Am I eligible? What happens if nothing launches?

Visual approval concerns identity, hierarchy, consistency and density. UX approval concerns state completeness and understandable actions. These are design judgments. User comprehension, responsive behavior, signing safety and live economics require later prototype/engineering validation and cannot honestly be scored as already proven.
