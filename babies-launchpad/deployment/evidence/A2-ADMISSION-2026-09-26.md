# Shared worker capacity checkpoint

26 September 2026 · feature/public-launches · local implementation, not activated.

Added shared token buckets with hard reservations per service lane. PostgreSQL replicas
use the database clock and serialize updates for the same resource/lane. Replicas share
one allowance; fee collection cannot borrow the launch reservation. Total lane rates and
bursts cannot exceed the configured resource envelope. Conflicting service configurations
fail closed. Fractional rates support small reservations within existing signer limits.
No production quotas were selected and no signer spend/rate ceiling was raised.

RPC and remote-signing transports now accept admission guards. Capacity denial yields a
job without exhausting its failure retries. Historical chart backfill has a separate lane
from live indexing. Shutdown returns a lease acquired during the stop race without starting
its handler or discarding unresolved transaction evidence.

## Evidence

- 133 focused tests passed, zero failures/skips, including real PostgreSQL 16 replica
  contention, independent launch/harvest capacity, policy conflict and restart behaviour.
- Transport tests prove denied admission makes no upstream RPC/signing request.
- Shutdown regression proves the raced lease is returned with reconciliation intact.
- Publication pattern scan: 704 files, zero findings; not proof of absence of every secret.

## Limits and next work

Transport guards are optional for existing callers to preserve legacy behaviour. New role
composition must require them. This checkpoint does not make the existing API stateless,
move its timers or qualify independently deployed workers. Partition selection must fit
provider request/credit windows, endpoint classes and unmetered legacy traffic. Token
buckets alone do not enforce a provider's separate rolling-window or compute-credit limits.
Small bursts also need representative multi-call job progress tests to avoid starvation.

The signer still needs an authoritative active-lease check, in addition to its historical
fencing high-water mark, before new multi-worker financial paths can activate. Physical
role separation, end-to-end provisioning and mixed-load qualification remain pending.

Ultimate goal: **partial**. Shared capacity and safe shutdown are now tested locally;
100-coin launch/trade reliability and production readiness are not yet demonstrated.
