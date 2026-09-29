-- Wallet-signed packets survive restarts and are bound to one request before any broadcast.
CREATE TABLE IF NOT EXISTS wallet_packets (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  prepared_json TEXT NOT NULL,
  signed_base64 TEXT,
  signature TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner, campaign_id, request_key)
);
CREATE INDEX IF NOT EXISTS wallet_packets_owner ON wallet_packets(owner, updated_at);
