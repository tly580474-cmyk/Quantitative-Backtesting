CREATE TABLE IF NOT EXISTS index_constituent_snapshots (
  snapshot_id VARCHAR(36) PRIMARY KEY,
  index_code VARCHAR(20) NOT NULL,
  index_name VARCHAR(255) NOT NULL,
  constituent_date DATE NOT NULL,
  weight_date DATE NULL,
  source_key VARCHAR(64) NOT NULL,
  source_checksum VARCHAR(64) NOT NULL,
  fetched_at DATETIME(3) NOT NULL,
  member_count INT UNSIGNED NOT NULL,
  weight_sum_pct DOUBLE NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'published',
  UNIQUE INDEX idx_ics_version (index_code, constituent_date, source_key, source_checksum),
  INDEX idx_ics_index_date (index_code, constituent_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS index_constituent_members (
  snapshot_id VARCHAR(36) NOT NULL,
  constituent_code VARCHAR(20) NOT NULL,
  instrument_key INT UNSIGNED NULL,
  constituent_name VARCHAR(255) NOT NULL,
  constituent_name_en VARCHAR(255) NULL,
  exchange VARCHAR(64) NULL,
  exchange_en VARCHAR(128) NULL,
  weight_pct DOUBLE NULL,
  raw_code VARCHAR(32) NOT NULL,
  PRIMARY KEY (snapshot_id, constituent_code),
  INDEX idx_icm_instrument (instrument_key),
  INDEX idx_icm_code (constituent_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
