-- Repair migration for databases where 0031 was recorded but its tables are absent.

CREATE TABLE IF NOT EXISTS paper_strategy_bindings (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  strategy_id VARCHAR(128) NOT NULL,
  strategy_name VARCHAR(255) NOT NULL,
  params JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'paused',
  last_evaluated_at DATETIME(3) NULL,
  last_signal JSON NULL,
  last_error VARCHAR(1000) NULL,
  last_intent_key VARCHAR(128) NULL,
  last_intent_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY idx_psb_account_strategy (account_id, strategy_id),
  KEY idx_psb_status (status, last_evaluated_at),
  CONSTRAINT fk_psb_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_risk_configs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  max_single_position_ratio DECIMAL(8,6) NULL,
  max_total_position_ratio DECIMAL(8,6) NULL,
  max_order_amount DECIMAL(20,4) NULL,
  max_daily_turnover DECIMAL(20,4) NULL,
  max_daily_orders INT UNSIGNED NULL,
  max_drawdown_ratio DECIMAL(8,6) NULL,
  max_daily_loss DECIMAL(20,4) NULL,
  rule_version VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY idx_prc_account (account_id),
  CONSTRAINT fk_prc_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  trade_date DATE NOT NULL,
  cash_balance DECIMAL(20,4) NOT NULL,
  frozen_cash DECIMAL(20,4) NOT NULL DEFAULT 0,
  market_value DECIMAL(20,4) NOT NULL DEFAULT 0,
  total_equity DECIMAL(20,4) NOT NULL,
  initial_cash DECIMAL(20,4) NOT NULL,
  return_ratio DECIMAL(12,8) NOT NULL,
  daily_return_ratio DECIMAL(12,8) NULL,
  max_drawdown_ratio DECIMAL(12,8) NULL,
  peak_equity DECIMAL(20,4) NULL,
  benchmark_code VARCHAR(20) NULL,
  benchmark_close DECIMAL(20,4) NULL,
  risk_rejections INT UNSIGNED NOT NULL DEFAULT 0,
  rule_version VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY idx_pes_account_date (account_id, trade_date),
  KEY idx_pes_date (trade_date),
  CONSTRAINT fk_pes_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_risk_events (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  order_id CHAR(36) NULL,
  rule_code VARCHAR(64) NOT NULL,
  rule_version VARCHAR(64) NOT NULL,
  metric_snapshot JSON NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_pre_account_created (account_id, created_at),
  KEY idx_pre_rule (rule_code, created_at),
  CONSTRAINT fk_pre_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
