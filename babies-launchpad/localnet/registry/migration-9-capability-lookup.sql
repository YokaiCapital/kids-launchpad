-- Latest grant lookup must stay bounded as campaign and grant history grows.
-- Do not filter revoked/expired grants here: those supersede older valid grants.
CREATE INDEX IF NOT EXISTS signer_capabilities_latest
 ON signer_capabilities(genesis_hash,program_id,campaign,created_at DESC,capability_id DESC);
