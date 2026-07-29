-- Persistent cross-task memory for duplicate and repeatedly invalid factor directions.

CREATE TABLE IF NOT EXISTS factor_search_feedback (
  signature CHAR(64) PRIMARY KEY,
  family_signature CHAR(64) NOT NULL,
  direction VARCHAR(24) NOT NULL,
  seen_count INT UNSIGNED NOT NULL DEFAULT 1,
  failure_count INT UNSIGNED NOT NULL DEFAULT 0,
  success_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_candidate_id VARCHAR(36),
  last_reason VARCHAR(1000),
  first_seen_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  INDEX idx_fsf_family_direction (family_signature, direction),
  INDEX idx_fsf_outcome (failure_count, success_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
