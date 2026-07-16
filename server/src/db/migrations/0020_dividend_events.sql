CREATE TABLE IF NOT EXISTS dividend_events (
  event_id VARCHAR(36) PRIMARY KEY,
  instrument_key INT UNSIGNED NOT NULL,
  report_period DATE NOT NULL,
  disclosure_date DATE NULL,
  announcement_date DATE NULL,
  record_date DATE NULL,
  ex_date DATE NULL,
  latest_announcement_date DATE NULL,
  cash_dividend_per_share DOUBLE NULL,
  bonus_share_per_share DOUBLE NULL,
  transfer_share_per_share DOUBLE NULL,
  dividend_yield_raw DOUBLE NULL,
  plan_status VARCHAR(32) NULL,
  raw_plan VARCHAR(1000) NULL,
  source_key VARCHAR(64) NOT NULL,
  source_fingerprint VARCHAR(64) NOT NULL,
  fetched_at DATETIME(3) NOT NULL,
  UNIQUE INDEX idx_de_source_fingerprint (source_fingerprint),
  INDEX idx_de_instrument_ex_date (instrument_key, ex_date),
  INDEX idx_de_report_period (report_period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reference_data_backfill_items (
  task_key VARCHAR(64) NOT NULL,
  instrument_key INT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(1000) NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (task_key, instrument_key),
  INDEX idx_rdbi_task_status (task_key, status, instrument_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
