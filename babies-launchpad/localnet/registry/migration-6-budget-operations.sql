-- Idempotent accounting entries. These are not evidence of an on-chain transfer;
-- callers bind them to a verified funding/payment or a durable spend reservation.
CREATE TABLE IF NOT EXISTS budget_operations (
  genesis_hash TEXT NOT NULL,
  program_id TEXT NOT NULL,
  campaign TEXT NOT NULL,
  payer TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(genesis_hash, program_id, campaign, payer, operation_key)
);
