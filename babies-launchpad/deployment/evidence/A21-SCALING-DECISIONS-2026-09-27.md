# A21: measured, bounded worker scaling advice

Status: private decision logic verified; no hosted autoscaler installed.

The observer can produce a bounded plan using explicit measured lane policy,
provider replica inventory and acknowledged change/idle history. It protects
independent warm minima, finite aggregate and per-lane ceilings, recovery/launch
priority, cooldown, and sustained idle before downscaling. It refuses speculative
growth for stale data, mismatched role capacity, unavailable authority/funding or
saturated upstreams. It never treats a proposed downscale as already applied.

Workers now emit monotonic execution-slot duration independently of queue delay.
A broken duration-metrics sink cannot retain an execution slot or alter a job's
financial outcome. These measurements can inform `measuredJobMs`; no unmeasured
production value or increased signer/RPC allowance was selected.

Validation: 19 observer/presence/scaling tests and 15 runner tests pass. Cases
include stale/future observations, aggregate ceilings, preserving another lane's
warm capacity, cooldown, active/unknown money work, unavailable funding/grants,
and metrics failures. The command always returns `apply: false`.

Against the ultimate goal, demand scaling improves to partial. Hosted actuation
with leader ownership, provider acknowledgements, scheduled-close pre-scaling,
intake control, alert delivery and qualified upstream budgets are still required.
Existing deployments and funded programs are unchanged.
