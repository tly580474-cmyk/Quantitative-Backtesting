-- Phase 5.5: compact authoritative history store and resumable imports.

ALTER TABLE instruments
  ADD COLUMN instrument_key INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ADD UNIQUE INDEX idx_inst_instrument_key (instrument_key);

CREATE TABLE IF NOT EXISTS daily_bars_v2 (
  instrument_key INT UNSIGNED NOT NULL,
  trade_date DATE NOT NULL,
  open DOUBLE NOT NULL,
  high DOUBLE NOT NULL,
  low DOUBLE NOT NULL,
  close DOUBLE NOT NULL,
  previous_close DOUBLE NULL,
  volume BIGINT UNSIGNED NULL,
  amount DOUBLE NULL,
  turnover_rate_pct DOUBLE NULL,
  source_key INT UNSIGNED NOT NULL DEFAULT 1,
  source_version VARCHAR(64) NOT NULL,
  fetched_at DATETIME(3) NOT NULL,
  PRIMARY KEY (instrument_key, trade_date),
  INDEX idx_dbv2_trade_date_instrument (trade_date, instrument_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS daily_stock_metrics (
  instrument_key INT UNSIGNED NOT NULL,
  trade_date DATE NOT NULL,
  total_shares BIGINT UNSIGNED NULL,
  float_shares BIGINT UNSIGNED NULL,
  total_market_cap DOUBLE NULL,
  float_market_cap DOUBLE NULL,
  pe_ttm DOUBLE NULL,
  pb DOUBLE NULL,
  ps_ttm DOUBLE NULL,
  volume_ratio DOUBLE NULL,
  is_st TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_limit_up TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (instrument_key, trade_date),
  INDEX idx_dsm_trade_date_instrument (trade_date, instrument_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS adjustment_factors_v2 (
  instrument_key INT UNSIGNED NOT NULL,
  effective_date DATE NOT NULL,
  factor_version VARCHAR(32) NOT NULL,
  factor DOUBLE NOT NULL,
  source_key INT UNSIGNED NOT NULL DEFAULT 1,
  source_batch_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (instrument_key, effective_date, factor_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS adjusted_bar_overrides (
  instrument_key INT UNSIGNED NOT NULL,
  trade_date DATE NOT NULL,
  adjustment_mode VARCHAR(4) NOT NULL,
  open DOUBLE NOT NULL,
  high DOUBLE NOT NULL,
  low DOUBLE NOT NULL,
  close DOUBLE NOT NULL,
  reason VARCHAR(64) NOT NULL,
  source_batch_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (instrument_key, trade_date, adjustment_mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS data_import_batches (
  id VARCHAR(36) PRIMARY KEY,
  source_root VARCHAR(1024) NOT NULL,
  source_snapshot VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  total_files INT NOT NULL DEFAULT 0,
  completed_files INT NOT NULL DEFAULT 0,
  total_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
  imported_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  published_at DATETIME(3) NULL,
  INDEX idx_dib_status_started (status, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS data_import_files (
  batch_id VARCHAR(36) NOT NULL,
  relative_path VARCHAR(512) NOT NULL,
  adjustment_mode VARCHAR(4) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  expected_rows INT UNSIGNED NOT NULL DEFAULT 0,
  imported_rows INT UNSIGNED NOT NULL DEFAULT 0,
  min_date DATE NULL,
  max_date DATE NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  error_message VARCHAR(1000) NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (batch_id, relative_path),
  INDEX idx_dif_batch_status (batch_id, status),
  INDEX idx_dif_checksum (checksum)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
