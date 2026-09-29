-- A campaign's lookup table for its funding-first launch, allocated durably before the first signature. A lookup table's
-- address derives from (authority, creation slot) only, so the plan reserves one (payer, slot) per campaign, unique across
-- the keeper's campaigns, and every retry reuses it (jobs/lookup-table-plan.mjs).
CREATE TABLE IF NOT EXISTS lookup_table_plans(
 genesis_hash TEXT NOT NULL,
 program_id TEXT NOT NULL,
 campaign TEXT NOT NULL,
 payer TEXT NOT NULL,
 table_address TEXT NOT NULL,
 recent_slot BIGINT NOT NULL,
 status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','created','complete')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(genesis_hash,program_id,campaign),
 UNIQUE(genesis_hash,program_id,payer,recent_slot),
 UNIQUE(table_address)
);
