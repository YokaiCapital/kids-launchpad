# Program versioning and isolation

Owner instruction, 24 September 2026: innovations and new on-chain features use new programs. Do not alter old programs to introduce them.

## Required rules

- New custody rules, economics or other on-chain mechanics require a separately deployed program and a new program ID. A feature flag or new instruction added by upgrading an existing program is not sufficient isolation.
- Existing campaigns retain their original program IDs, sealed terms, custody, claim/refund paths, fee rules, vesting and liquidity locks. No silent migration or retroactive opt-in.
- Never upgrade, redeploy over, close, drain or repurpose an existing deployed program/account for a new feature. Any exceptional maintenance/security change to an old program needs a separate explicit decision and review; this feature authorization does not grant it.
- Identify and route each campaign by genesis hash + program ID + campaign address. Do not select transaction builders or decoders using a global latest-program value or a slug alone. Verify account owners and reject unsupported versions.
- New programs use their own PDAs, custody accounts, signer capabilities, keeper jobs and versioned configuration. Do not give a new program or operator signing/withdrawal authority over old custody. Reuse reviewed source libraries where appropriate without mutating deployed old programs.
- New program deployment does not activate public creation automatically. Activation names the exact new program/version and policy, after its own security review and end-to-end tests.
- Shared API, wallet, indexer and frontend changes must preserve old version adapters and be regression-tested against old campaign claim/refund/trade/fee/vesting behaviour. Old keeper jobs continue using their original adapters. A new feature must not stop old servicing.
- Rollback disables creation/use of the new feature; it does not redirect existing or newly funded campaigns to a different program. Funded new campaigns continue to have their version-specific servicing and exit paths.
- Publish each version's program IDs, source/build evidence, authority status and supported policies. Preserve historical evidence and versioned documentation. Never reuse an old program ID under a new feature name.

## Current application

The separate Direct launch feature (no parents within Direct; existing parent and Standard launches preserved), with its 50% permanent / 50% temporary LP design, with 3% of remaining temporary LP recycled daily, must use new program IDs and separate custody. It must not be implemented through an upgrade to atomic-launch, distribution, vesting or kids-launch-v2 programs already used by campaigns. Its design is not activated; remaining policy parameters and implementation/review gates are unresolved.
