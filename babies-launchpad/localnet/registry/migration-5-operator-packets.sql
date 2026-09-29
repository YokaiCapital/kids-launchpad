-- Exact operator packets, including auxiliary signatures, survive before signing/broadcast.
-- Never store auxiliary private keys. Attempts advance only after a terminal chain verdict.
CREATE TABLE IF NOT EXISTS operator_packets (
  operation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  descriptor TEXT NOT NULL,
  prepared_json TEXT NOT NULL,
  signed_base64 TEXT,
  signature TEXT,
  status TEXT NOT NULL CHECK(status IN ('prepared','signed','confirmed','finalized','failed','expired')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(operation_id, attempt)
);
CREATE INDEX IF NOT EXISTS operator_packets_pending ON operator_packets(status, updated_at);
