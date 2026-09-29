-- Shared upstream capacity. Lane partitions cannot consume another lane's reserve.
CREATE TABLE IF NOT EXISTS admission_policies (
  resource TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admission_buckets (
  resource TEXT NOT NULL,
  lane TEXT NOT NULL,
  tokens_micro TEXT NOT NULL,
  updated_ms BIGINT NOT NULL,
  PRIMARY KEY(resource, lane),
  FOREIGN KEY(resource) REFERENCES admission_policies(resource)
);
