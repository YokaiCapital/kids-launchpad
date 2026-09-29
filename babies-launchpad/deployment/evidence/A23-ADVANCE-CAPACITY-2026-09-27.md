# A23: complete admission observations and advance capacity

The private worker observer now supports either a partitioned resource or an
explicit resource per lane, plus the independent signer evidence-RPC allocation.
It verifies the requested partition exists and reports missing evidence as
unavailable. Reads neither spend tokens nor mutate work, and exported metric
labels remain fixed-cardinality roles rather than provider names or credentials.

Financial scale advice now considers three separate constraints: worker RPC,
signature admission and signer evidence RPC. Missing or congested signer evidence
prevents speculative financial scale-up, without blocking signer-free lanes.

The observer also counts scheduled jobs in cumulative 60/300/600-second horizons.
An explicitly chosen prewarming horizon feeds the bounded capacity estimate and
prevents idle downscaling while scheduled work approaches. These are job counts,
including deliberate rechecks, not distinct launch counts. A qualified minimum
must still cover future refund work not yet enqueued. No unacknowledged scale-down
is credited as spare capacity for another lane.

Validation: **23 observer, presence and scaling tests pass** with PostgreSQL,
including upcoming work, missing partitions, unavailable signer evidence,
read-only admission snapshots, stale observations and protected warm minima.
An actual read of the retained mixed fleet observed all six financial RPC and
signature partitions plus the separate signer evidence allocation, while 100
lifecycle jobs were scheduled. This is an observation, not deployment actuation.

Against the ultimate goal, visibility and advance capacity decisions improve.
The hosted controller still needs single leadership, provider inventory and
acknowledgements, graceful drain, qualified boot times and quotas. Advice remains
`apply:false`; it cannot alter financial authority, spending limits or old coins.
