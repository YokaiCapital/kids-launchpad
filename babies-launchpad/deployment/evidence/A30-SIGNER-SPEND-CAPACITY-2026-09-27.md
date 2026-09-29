# A30: signer spending capacity remains a hard boundary

The retained 100-launch mixed rehearsal reached its unchanged 5 SOL rolling-hour
signer budget after 100 launches/refunds and 91 fee activations. This is a separate
resource from worker slots, RPC rate, request rate and credited operating funding.
The run retained its approvals and charges; no budget reset or increase was used.

The v3 capacity response now identifies RPC, request-rate or hourly-spend waits.
Only these enumerated reasons cross the signer client and durable worker result.
An hourly-spend refusal yields without consuming transient retry allowance or
creating a signature. Private observations expose a separate spend-wait metric
and alert. Scaling holds an affected signing lane instead of adding replicas
that cannot resolve its spend limit. Legacy refusal behavior is unchanged.

Validation: 55 focused checks and the full 724-test regression pass with no skips,
using PostgreSQL and installed codecs. Tests cover repeated refused packets,
restart-retained charges, sanitized durable waits and bounded scaling decisions.
These are not a hosted capacity or independent-security qualification. Intake
must account for simultaneous close/setup cost and ongoing operations before
public launch admission can be enabled. No financial terms or deployed service
were changed.
