-- Phase 4.5: Initial MySQL schema for quant_backtest
-- Run with: mysql -u root -p quant_backtest < 0000_initial.sql

CREATE TABLE IF NOT EXISTS market_datasets (
  id VARCHAR(36) PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  timeframe VARCHAR(10) NOT NULL DEFAULT '1d',
  start_time VARCHAR(10) NOT NULL,
  end_time VARCHAR(10) NOT NULL,
  count INT NOT NULL,
  source_file_name VARCHAR(255),
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_md_checksum (checksum),
  INDEX idx_md_symbol (symbol),
  INDEX idx_md_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS candles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  dataset_id VARCHAR(36) NOT NULL,
  time VARCHAR(10) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  open DOUBLE NOT NULL,
  high DOUBLE NOT NULL,
  low DOUBLE NOT NULL,
  close DOUBLE NOT NULL,
  `change` DOUBLE,
  change_percent DOUBLE,
  volume DOUBLE,
  turnover DOUBLE,
  constituent_count DOUBLE,
  UNIQUE INDEX idx_candles_dataset_time (dataset_id, time),
  INDEX idx_candles_dataset (dataset_id),
  INDEX idx_candles_time (time),
  CONSTRAINT fk_candles_dataset FOREIGN KEY (dataset_id) REFERENCES market_datasets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_configs (
  id VARCHAR(36) PRIMARY KEY,
  strategy_id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  params JSON NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  INDEX idx_sc_strategy_id (strategy_id),
  INDEX idx_sc_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS backtest_results (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL,
  dataset_snapshot JSON NOT NULL,
  strategy_id VARCHAR(64) NOT NULL,
  strategy_version VARCHAR(32) NOT NULL,
  strategy_params JSON NOT NULL,
  config JSON NOT NULL,
  started_at VARCHAR(24) NOT NULL,
  completed_at VARCHAR(24) NOT NULL,
  metrics JSON NOT NULL,
  signals JSON NOT NULL,
  trades JSON NOT NULL,
  equity_curve JSON NOT NULL,
  error VARCHAR(1000),
  INDEX idx_br_status (status),
  INDEX idx_br_started_at (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS equity_points (
  id INT AUTO_INCREMENT PRIMARY KEY,
  result_id VARCHAR(36) NOT NULL,
  time VARCHAR(10) NOT NULL,
  cash DOUBLE NOT NULL,
  market_value DOUBLE NOT NULL,
  equity DOUBLE NOT NULL,
  drawdown DOUBLE NOT NULL,
  position_quantity DOUBLE NOT NULL,
  contributed_capital DOUBLE,
  UNIQUE INDEX idx_ep_result_time (result_id, time),
  INDEX idx_ep_result (result_id),
  CONSTRAINT fk_ep_result FOREIGN KEY (result_id) REFERENCES backtest_results(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS visual_strategies (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  document JSON NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  INDEX idx_vs_status (status),
  INDEX idx_vs_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_versions (
  id VARCHAR(36) PRIMARY KEY,
  strategy_id VARCHAR(36) NOT NULL,
  version INT NOT NULL,
  document JSON NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_sv_strategy_version (strategy_id, version),
  INDEX idx_sv_strategy (strategy_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_drafts (
  id VARCHAR(36) PRIMARY KEY,
  strategy_id VARCHAR(36) NOT NULL,
  document JSON NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  INDEX idx_sd_strategy_id (strategy_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
