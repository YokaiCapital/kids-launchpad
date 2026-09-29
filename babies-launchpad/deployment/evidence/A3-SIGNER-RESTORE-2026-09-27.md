# V3 signer journal restart qualification

Scope: isolated localnet Standard v3. Existing financial programs and legacy
signer persistence are unchanged. This is not approval for hosted activation.

The registry signer checks its private disk journal against the exact
genesis/program/payer PostgreSQL scope before listening. Saved approvals must
match operating holds; saved job fences cannot exceed database fences; recent
signed shadow packets must have matching saved approvals. Missing history,
malformed/duplicate records, foreign payer history, symlinks and permissive
file modes refuse startup. Nothing silently reconstructs spend history.

V3 writes now fsync the file, rename it and fsync its directory. Every signature,
including an identical retry, follows a successful journal flush. A test makes
the journal unwritable after signing, confirms that repeated retries return no
signature, then restores storage and recovers the identical signature.

Validation:

- Full bounded regression: **537 passed, 0 failed, 0 skipped**, including real
  PostgreSQL restore tests and existing legacy signer checks.
- Fresh owned-validator lifecycle campaign
  `22xioSog2gr6MTfB1fcAfjPTgJJpGLNxyDnb71JpowP3` completed settlement, launch,
  1 SOL excess refund, fee setup/activation and three independent fee jobs.
- Both controller and signer restarted from their existing history. Custody
  verification passed again after participant/dev claims, burn and trade.
- Operating reserve: 40,000,000 lamports funded; 14,320,840 spent; zero held;
  25,679,160 available. No participant principal financed operations.

Limits: coordinated rollback of both database and disk cannot be detected by
comparing them alone. Before restoring production, stop writers, reconcile
transactions against finalized chain state, validate backup provenance and
retained signatures, and qualify the restored copy privately. Never delete a
journal or edit rows merely to bypass refusal. Hosted single-writer ownership,
backup retention, full PITR and incident drills remain release gates.
