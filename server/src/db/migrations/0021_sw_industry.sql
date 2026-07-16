CREATE TABLE IF NOT EXISTS sw_industry_definitions (
  taxonomy_key VARCHAR(32) NOT NULL,
  industry_code VARCHAR(12) NOT NULL,
  industry_name VARCHAR(128) NOT NULL,
  industry_level TINYINT UNSIGNED NOT NULL,
  parent_code VARCHAR(12) NULL,
  index_code VARCHAR(12) NULL,
  source_key VARCHAR(64) NOT NULL,
  source_version VARCHAR(64) NOT NULL,
  fetched_at DATETIME(3) NOT NULL,
  PRIMARY KEY (taxonomy_key, industry_code),
  UNIQUE INDEX idx_sid_taxonomy_index (taxonomy_key, index_code),
  INDEX idx_sid_parent (taxonomy_key, parent_code),
  INDEX idx_sid_level (taxonomy_key, industry_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sw_industry_memberships (
  taxonomy_key VARCHAR(32) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  instrument_key INT UNSIGNED NULL,
  level1_code VARCHAR(12) NOT NULL,
  level2_code VARCHAR(12) NOT NULL,
  level3_code VARCHAR(12) NOT NULL,
  effective_from DATETIME(3) NOT NULL,
  effective_to DATETIME(3) NULL,
  source_key VARCHAR(64) NOT NULL,
  source_version VARCHAR(64) NOT NULL,
  source_updated_at DATETIME(3) NULL,
  fetched_at DATETIME(3) NOT NULL,
  PRIMARY KEY (taxonomy_key, symbol, effective_from),
  INDEX idx_sim_instrument_effective (instrument_key, effective_from, effective_to),
  INDEX idx_sim_level1_effective (taxonomy_key, level1_code, effective_from),
  INDEX idx_sim_level3_effective (taxonomy_key, level3_code, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sw_industry_daily_bars (
  taxonomy_key VARCHAR(32) NOT NULL,
  index_code VARCHAR(12) NOT NULL,
  industry_code VARCHAR(12) NOT NULL,
  industry_name VARCHAR(128) NOT NULL,
  trade_date DATE NOT NULL,
  open DOUBLE NOT NULL,
  high DOUBLE NOT NULL,
  low DOUBLE NOT NULL,
  close DOUBLE NOT NULL,
  `change` DOUBLE NULL,
  change_percent DOUBLE NULL,
  volume_raw DOUBLE NULL,
  amount_raw DOUBLE NULL,
  source_key VARCHAR(64) NOT NULL,
  source_version VARCHAR(64) NOT NULL,
  fetched_at DATETIME(3) NOT NULL,
  PRIMARY KEY (taxonomy_key, index_code, trade_date),
  INDEX idx_sib_trade_date (trade_date),
  INDEX idx_sib_industry_date (taxonomy_key, industry_code, trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
