-- Accounting only: finalized funding evidence credits one campaign/payer. A
-- transaction signature cannot fund two campaign ledgers on the same chain.
CREATE TABLE IF NOT EXISTS operating_funding_receipts (
 genesis_hash TEXT NOT NULL,
 signature TEXT NOT NULL,
 program_id TEXT NOT NULL,
 campaign TEXT NOT NULL,
 payer TEXT NOT NULL,
 descriptor TEXT NOT NULL,
 evidence_json TEXT NOT NULL,
 PRIMARY KEY(genesis_hash,signature),
 FOREIGN KEY(genesis_hash,program_id,campaign) REFERENCES campaigns(genesis_hash,program_id,campaign)
);
-- A hold reserves the maximum cost of one exact message, including while its
-- signature is unknown. Only verified finality/expiry can release that exposure.
CREATE TABLE IF NOT EXISTS operating_spend_holds (
 genesis_hash TEXT NOT NULL,
 program_id TEXT NOT NULL,
 campaign TEXT NOT NULL,
 payer TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 message_hash TEXT NOT NULL,
 maximum_lamports TEXT NOT NULL,
 policy TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('held','settled')),
 actual_lamports TEXT,
 evidence_json TEXT,
 PRIMARY KEY(genesis_hash,program_id,campaign,payer,operation_id),
 FOREIGN KEY(genesis_hash,program_id,campaign) REFERENCES campaigns(genesis_hash,program_id,campaign)
);
CREATE INDEX IF NOT EXISTS operating_spend_holds_active ON operating_spend_holds(genesis_hash,program_id,campaign,payer,state);
