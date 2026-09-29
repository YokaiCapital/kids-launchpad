-- KIDS public launches, P1 registry schema (plan section 8), migration 1.
-- One dialect for two engines: every statement here runs unchanged on node:sqlite and on PostgreSQL.
--   * amounts (lamports, token base units) are TEXT decimal strings, aggregated with BigInt in the adapter;
--   * slots, block times, ordinals and fencing tokens are BIGINT (64-bit on both engines);
--   * timestamps are TEXT in ISO 8601 UTC; flags are INTEGER 0/1;
--   * no PRAGMA, AUTOINCREMENT, WITHOUT ROWID, SERIAL, JSONB or engine-specific functions;
--   * every statement ends with a semicolon at the end of its line (registry.mjs splitStatements relies on that).
-- Campaign identity is (genesis_hash, program_id, campaign): a slug is only an alias; mint, ticker and name never identify.
-- The chain stays authoritative for balances and entitlements: every projection carries its source slot and commitment.

CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- Campaigns: one row per chain identity. registry_status says where the record comes from today
-- (active manifest, runtime or plan archive, plan file, identities file); chain_status is the phase last read from the chain.
CREATE TABLE IF NOT EXISTS campaigns(
  genesis_hash TEXT NOT NULL,
  program_id TEXT NOT NULL,
  campaign TEXT NOT NULL,
  ordinal BIGINT NOT NULL,
  slug TEXT,
  network TEXT,
  mode TEXT NOT NULL,
  campaign_version INTEGER NOT NULL,
  terms_hash TEXT,
  terms_json TEXT,
  registry_status TEXT NOT NULL,
  chain_status TEXT,
  source_slot BIGINT,
  source_commitment TEXT,
  legacy_adapter_version TEXT,
  source_paths TEXT NOT NULL,
  creator TEXT,
  nonce TEXT,
  mint TEXT,
  pool TEXT,
  name TEXT,
  symbol TEXT,
  dev TEXT,
  treasury TEXT,
  parent_mints TEXT,
  opens_at TEXT,
  deadline_unix BIGINT,
  launch_deadline_unix BIGINT,
  soft_cap_lamports TEXT,
  hard_cap_lamports TEXT,
  supply_raw TEXT,
  launch_signature TEXT,
  launched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(genesis_hash, program_id, campaign),
  UNIQUE(ordinal),
  UNIQUE(slug)
);
CREATE INDEX IF NOT EXISTS campaigns_list ON campaigns(chain_status, mode, ordinal);
CREATE INDEX IF NOT EXISTS campaigns_address ON campaigns(campaign);

-- Profiles: presentation only, revisioned, moderated independently of money state.
CREATE TABLE IF NOT EXISTS campaign_profiles(
  genesis_hash TEXT NOT NULL,
  program_id TEXT NOT NULL,
  campaign TEXT NOT NULL,
  revision INTEGER NOT NULL,
  authorized_creator TEXT NOT NULL,
  authorization_ref TEXT,
  name TEXT,
  symbol TEXT,
  description TEXT,
  media_json TEXT NOT NULL,
  links_json TEXT NOT NULL,
  moderation_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(genesis_hash, program_id, campaign, revision),
  FOREIGN KEY(genesis_hash, program_id, campaign) REFERENCES campaigns(genesis_hash, program_id, campaign)
);

-- Drafts: off-chain, per authenticated creator, optimistic revision; never holds a secret.
CREATE TABLE IF NOT EXISTS creator_drafts(
  creator TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(creator, draft_id)
);

-- Transaction intents: idempotent per campaign, wallet, action and client key; the approved message digest and the
-- financial parameters never change after creation (a new key means a new intent).
CREATE TABLE IF NOT EXISTS transaction_intents(
  intent_id TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  program_id TEXT NOT NULL,
  campaign TEXT NOT NULL,
  wallet TEXT NOT NULL,
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  message_digest TEXT,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL,
  signature TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(intent_id),
  UNIQUE(genesis_hash, program_id, campaign, wallet, action, idempotency_key),
  FOREIGN KEY(genesis_hash, program_id, campaign) REFERENCES campaigns(genesis_hash, program_id, campaign)
);
CREATE INDEX IF NOT EXISTS transaction_intents_wallet ON transaction_intents(genesis_hash, program_id, wallet, created_at);

-- Commitments: projection of the on-chain receipts (unique per genesis, owning program and receipt address).
CREATE TABLE IF NOT EXISTS commitments(
  genesis_hash TEXT NOT NULL,
  program_id TEXT NOT NULL,
  receipt TEXT NOT NULL,
  campaign TEXT NOT NULL,
  wallet TEXT NOT NULL,
  committed_lamports TEXT NOT NULL,
  accepted_lamports TEXT,
  refunded_lamports TEXT NOT NULL,
  settled INTEGER NOT NULL,
  claimed INTEGER NOT NULL,
  source_slot BIGINT NOT NULL,
  source_commitment TEXT NOT NULL,
  reconciled_at TEXT NOT NULL,
  PRIMARY KEY(genesis_hash, program_id, receipt),
  FOREIGN KEY(genesis_hash, program_id, campaign) REFERENCES campaigns(genesis_hash, program_id, campaign)
);
CREATE INDEX IF NOT EXISTS commitments_campaign ON commitments(genesis_hash, program_id, campaign);
CREATE INDEX IF NOT EXISTS commitments_wallet ON commitments(genesis_hash, program_id, wallet);

-- Claims: projection of claim records (funder, parent, dev), unique per genesis, owning program and claim address.
CREATE TABLE IF NOT EXISTS claims(
  genesis_hash TEXT NOT NULL,
  program_id TEXT NOT NULL,
  claim_address TEXT NOT NULL,
  campaign TEXT NOT NULL,
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  claimed INTEGER NOT NULL,
  signature TEXT,
  source_slot BIGINT NOT NULL,
  source_commitment TEXT NOT NULL,
  reconciled_at TEXT NOT NULL,
  PRIMARY KEY(genesis_hash, program_id, claim_address),
  FOREIGN KEY(genesis_hash, program_id, campaign) REFERENCES campaigns(genesis_hash, program_id, campaign)
);
CREATE INDEX IF NOT EXISTS claims_campaign ON claims(genesis_hash, program_id, campaign, kind);

-- Mint leases: vanity mint inventory bound to one campaign and creator; signer_ref names a key in the signer service,
-- never key material.
CREATE TABLE IF NOT EXISTS mint_leases(
  lease_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  genesis_hash TEXT,
  program_id TEXT,
  campaign TEXT,
  creator TEXT,
  state TEXT NOT NULL,
  signer_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(lease_id),
  UNIQUE(mint)
);

-- Operational budgets: per campaign and payer; a subsidy across campaigns needs an explicit platform policy row.
CREATE TABLE IF NOT EXISTS operational_budgets(
  genesis_hash TEXT NOT NULL,
  program_id TEXT NOT NULL,
  campaign TEXT NOT NULL,
  payer TEXT NOT NULL,
  reserved_lamports TEXT NOT NULL,
  spent_lamports TEXT NOT NULL,
  returned_lamports TEXT NOT NULL,
  policy TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(genesis_hash, program_id, campaign, payer),
  FOREIGN KEY(genesis_hash, program_id, campaign) REFERENCES campaigns(genesis_hash, program_id, campaign)
);

-- Jobs: durable work items with a lease owner, expiry and a fencing token that grows on every lease; a completion
-- must carry the current token, so a stale process cannot publish a result.
CREATE TABLE IF NOT EXISTS jobs(
  job_id TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  program_id TEXT NOT NULL,
  campaign TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  job_class TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  retry_count INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  fencing_token BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(job_id),
  UNIQUE(genesis_hash, program_id, campaign, operation_key)
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state, job_class, created_at);

-- Chain events: one row per genesis, signature, full instruction path and event kind.
CREATE TABLE IF NOT EXISTS chain_events(
  genesis_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  instruction_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  program_id TEXT,
  campaign TEXT,
  slot BIGINT NOT NULL,
  block_time BIGINT,
  status TEXT NOT NULL,
  asset_json TEXT,
  payload_json TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(genesis_hash, signature, instruction_path, kind)
);
CREATE INDEX IF NOT EXISTS chain_events_campaign ON chain_events(genesis_hash, program_id, campaign, slot);

-- Market cursors: durable, scoped backfill cursor per pool and denomination, with finality and last real trade times.
CREATE TABLE IF NOT EXISTS market_cursors(
  genesis_hash TEXT NOT NULL,
  pool TEXT NOT NULL,
  denomination TEXT NOT NULL,
  newest_signature TEXT,
  newest_slot BIGINT,
  oldest_signature TEXT,
  oldest_slot BIGINT,
  backfill_cursor TEXT,
  backfill_complete INTEGER NOT NULL,
  finalized_slot BIGINT,
  last_trade_at BIGINT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(genesis_hash, pool, denomination)
);

-- Candles: unique per genesis, pool, interval, denomination and bucket start.
CREATE TABLE IF NOT EXISTS candles(
  genesis_hash TEXT NOT NULL,
  pool TEXT NOT NULL,
  interval TEXT NOT NULL,
  denomination TEXT NOT NULL,
  bucket_start BIGINT NOT NULL,
  open TEXT NOT NULL,
  high TEXT NOT NULL,
  low TEXT NOT NULL,
  close TEXT NOT NULL,
  volume_quote TEXT NOT NULL,
  volume_base TEXT NOT NULL,
  trades INTEGER NOT NULL,
  buys INTEGER NOT NULL,
  sells INTEGER NOT NULL,
  first_slot BIGINT NOT NULL,
  last_slot BIGINT NOT NULL,
  finalized INTEGER NOT NULL,
  PRIMARY KEY(genesis_hash, pool, interval, denomination, bucket_start)
);
