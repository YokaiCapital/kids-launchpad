# A9: global launch-directory ordering

Date: 27 September 2026. Isolated implementation; no hosted activation.

Newest, closing-soon and name ordering now execute in the registry before pagination. The browser sends the chosen sort and preserves server order instead of sorting only the current page. Search/status/creator/type filters apply to the same query. Keyset cursors bind the sort, use a stable ordinal tie-breaker and refuse cross-sort continuation. Unknown deadlines sort last. Queries select from a fixed allow-list; no client SQL is interpolated. Schema 33 adds expression indexes for deadline and name scans. Names may change through moderation; as with any live directory, such edits can change subsequent page membership.

Validation: **616 regression tests passed, 0 failed/skipped**. Both SQLite and PostgreSQL enumerate all 65 ordered campaigns without loss or duplicates, including ties, filters, unknown deadlines and a concurrent newest insert. HTTP tests verify sort and mismatched cursors. Enabled build passes. Browser checks verify server sort requests and continuation, older portfolio positions, search, wallet changes and four viewport widths without overflow/errors.

Ultimate-goal comparison: usable multi-launch discovery improves, but production remains **partial**. The ordinary isolated creator composition still needs a shared current campaign/phase projection wired into directory reads; it currently returns unknown rather than inventing chain data. Funding, hosted media/wallets, mixed-chain scale, restore/monitoring and release/security gates remain. Existing coin programs and terms are unchanged.
