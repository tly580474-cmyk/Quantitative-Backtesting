CREATE TABLE IF NOT EXISTS fund_flow_sync_dates (
  source_key VARCHAR(32) NOT NULL,
  trade_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL,
  provider_rows INT UNSIGNED NOT NULL DEFAULT 0,
  stored_rows INT UNSIGNED NOT NULL DEFAULT 0,
  expected_market_rows INT UNSIGNED NOT NULL DEFAULT 0,
  coverage_pct DOUBLE NULL,
  error_message VARCHAR(1000) NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (source_key, trade_date),
  INDEX idx_ffsd_status_date (status, trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
