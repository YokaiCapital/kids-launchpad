-- Stable keyset scans for global deadline/name ordering.
CREATE INDEX IF NOT EXISTS campaign_directory_deadline ON campaigns(COALESCE(deadline_unix,9007199254740991),ordinal DESC);
CREATE INDEX IF NOT EXISTS campaign_directory_name ON campaigns(LOWER(COALESCE(name,'')),ordinal DESC);
