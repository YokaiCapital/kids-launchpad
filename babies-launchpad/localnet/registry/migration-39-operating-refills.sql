-- Option 1 refills (owner decision 27 September 2026): what a live coin's treasury fee share entitles its campaign's
-- operating budget to, computed from finalized fee-state counters, and the treasury-signed fundings that credit it.
CREATE TABLE IF NOT EXISTS operating_refills(
 genesis_hash TEXT NOT NULL,
 program_id TEXT NOT NULL,
 campaign TEXT NOT NULL,
 payer TEXT NOT NULL,
 policy TEXT NOT NULL,
 treasury_paid_accounted TEXT NOT NULL DEFAULT '0',
 due_lamports TEXT NOT NULL DEFAULT '0',
 funded_lamports TEXT NOT NULL DEFAULT '0',
 pending_funding_id TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(genesis_hash,program_id,campaign,payer),
 FOREIGN KEY(genesis_hash,program_id,campaign) REFERENCES campaigns(genesis_hash,program_id,campaign)
);
CREATE TABLE IF NOT EXISTS operating_refill_fundings(
 funding_id TEXT PRIMARY KEY,
 genesis_hash TEXT NOT NULL,
 program_id TEXT NOT NULL,
 payer TEXT NOT NULL,
 policy TEXT NOT NULL,
 treasury TEXT NOT NULL,
 entitlements_json TEXT NOT NULL,
 total_lamports TEXT NOT NULL,
 memo TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','credited','void')),
 signature TEXT,
 slot BIGINT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operating_refill_fundings_open ON operating_refill_fundings(genesis_hash,program_id,payer,state);
