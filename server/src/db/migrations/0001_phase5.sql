-- Phase 5: Automated Market Data Platform
-- Tables: instruments, provider_symbol_mappings, trading_calendar,
--         daily_candles, adjustment_factors, market_data_versions,
--         sync_jobs, sync_job_items, data_quality_issues

CREATE TABLE IF NOT EXISTS instruments (
  id VARCHAR(36) PRIMARY KEY,
  market VARCHAR(16) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(32) NOT NULL,
  list_date VARCHAR(10),
  delist_date VARCHAR(10),
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_inst_market_symbol_type (market, symbol, type),
  INDEX idx_inst_status (status),
  INDEX idx_inst_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS provider_symbol_mappings (
  id VARCHAR(36) PRIMARY KEY,
  provider_id VARCHAR(64) NOT NULL,
  instrument_id VARCHAR(36) NOT NULL,
  provider_symbol VARCHAR(64) NOT NULL,
  UNIQUE INDEX idx_psm_provider_inst (provider_id, instrument_id),
  INDEX idx_psm_provider_symbol (provider_id, provider_symbol),
  INDEX idx_psm_instrument (instrument_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trading_calendar (
  id VARCHAR(36) PRIMARY KEY,
  market VARCHAR(16) NOT NULL,
  trade_date VARCHAR(10) NOT NULL,
  is_open TINYINT NOT NULL DEFAULT 1,
  session_metadata JSON,
  UNIQUE INDEX idx_tcal_market_date (market, trade_date),
  INDEX idx_tcal_date (trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS daily_candles (
  id VARCHAR(36) PRIMARY KEY,
  instrument_id VARCHAR(36) NOT NULL,
  trade_date VARCHAR(10) NOT NULL,
  open DOUBLE NOT NULL,
  high DOUBLE NOT NULL,
  low DOUBLE NOT NULL,
  close DOUBLE NOT NULL,
  volume DOUBLE NOT NULL,
  turnover DOUBLE,
  source_id VARCHAR(64) NOT NULL,
  source_version VARCHAR(32) NOT NULL DEFAULT '1',
  fetched_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_dc_inst_date_src (instrument_id, trade_date, source_id),
  INDEX idx_dc_instrument (instrument_id),
  INDEX idx_dc_date (trade_date),
  INDEX idx_dc_source (source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS adjustment_factors (
  id VARCHAR(36) PRIMARY KEY,
  instrument_id VARCHAR(36) NOT NULL,
  trade_date VARCHAR(10) NOT NULL,
  factor DOUBLE NOT NULL,
  source_id VARCHAR(64) NOT NULL,
  fetched_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_af_inst_date_src (instrument_id, trade_date, source_id),
  INDEX idx_af_instrument (instrument_id),
  INDEX idx_af_date (trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS market_data_versions (
  id VARCHAR(36) PRIMARY KEY,
  instrument_id VARCHAR(36) NOT NULL,
  start_date VARCHAR(10) NOT NULL,
  end_date VARCHAR(10) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  adjustment_version VARCHAR(16) NOT NULL DEFAULT '1',
  quality_status VARCHAR(16) NOT NULL DEFAULT 'pass',
  record_count INT NOT NULL DEFAULT 0,
  created_at VARCHAR(24) NOT NULL,
  INDEX idx_mdv_instrument (instrument_id),
  INDEX idx_mdv_quality (quality_status),
  INDEX idx_mdv_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sync_jobs (
  id VARCHAR(36) PRIMARY KEY,
  job_type VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  provider_id VARCHAR(64) NOT NULL,
  request_snapshot JSON NOT NULL,
  total_items INT NOT NULL DEFAULT 0,
  completed_items INT NOT NULL DEFAULT 0,
  failed_items INT NOT NULL DEFAULT 0,
  started_at VARCHAR(24),
  finished_at VARCHAR(24),
  created_at VARCHAR(24) NOT NULL,
  INDEX idx_sj_status_created (status, created_at),
  INDEX idx_sj_type (job_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sync_job_items (
  id VARCHAR(36) PRIMARY KEY,
  job_id VARCHAR(36) NOT NULL,
  instrument_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  error_code VARCHAR(32),
  error_message VARCHAR(1000),
  INDEX idx_sji_job (job_id),
  INDEX idx_sji_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id VARCHAR(36) PRIMARY KEY,
  instrument_id VARCHAR(36) NOT NULL,
  trade_date VARCHAR(10) NOT NULL,
  rule_code VARCHAR(64) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  details JSON,
  detected_at VARCHAR(24) NOT NULL,
  resolved_at VARCHAR(24),
  INDEX idx_dqi_status_severity (status, severity, detected_at),
  INDEX idx_dqi_instrument (instrument_id),
  INDEX idx_dqi_date (trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
