CREATE TABLE IF NOT EXISTS paper_accounts (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  initial_cash DECIMAL(20,4) NOT NULL,
  cash_balance DECIMAL(20,4) NOT NULL,
  frozen_cash DECIMAL(20,4) NOT NULL DEFAULT 0,
  commission_rate DECIMAL(12,8) NOT NULL DEFAULT 0.00030000,
  minimum_commission DECIMAL(20,4) NOT NULL DEFAULT 5.0000,
  sell_tax_rate DECIMAL(12,8) NOT NULL DEFAULT 0.00050000,
  slippage_bps DECIMAL(12,4) NOT NULL DEFAULT 1.0000,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_pa_status_updated (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_orders (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  instrument_key INT UNSIGNED NOT NULL,
  client_order_id VARCHAR(64) NOT NULL,
  security_code VARCHAR(20) NOT NULL,
  security_name VARCHAR(255) NOT NULL,
  market VARCHAR(16) NOT NULL,
  side VARCHAR(8) NOT NULL,
  order_type VARCHAR(16) NOT NULL,
  time_in_force VARCHAR(8) NOT NULL DEFAULT 'day',
  quantity DECIMAL(20,6) NOT NULL,
  limit_price DECIMAL(20,4) NULL,
  status VARCHAR(24) NOT NULL,
  filled_quantity DECIMAL(20,6) NOT NULL DEFAULT 0,
  average_fill_price DECIMAL(20,4) NULL,
  frozen_cash DECIMAL(20,4) NOT NULL DEFAULT 0,
  frozen_quantity DECIMAL(20,6) NOT NULL DEFAULT 0,
  reject_code VARCHAR(64) NULL,
  reject_reason VARCHAR(500) NULL,
  rule_version VARCHAR(64) NOT NULL,
  submitted_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY idx_po_account_client (account_id, client_order_id),
  KEY idx_po_account_status (account_id, status, submitted_at),
  KEY idx_po_instrument_status (instrument_key, status),
  CONSTRAINT fk_po_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_positions (
  account_id CHAR(36) NOT NULL,
  instrument_key INT UNSIGNED NOT NULL,
  security_code VARCHAR(20) NOT NULL,
  security_name VARCHAR(255) NOT NULL,
  market VARCHAR(16) NOT NULL,
  total_quantity DECIMAL(20,6) NOT NULL DEFAULT 0,
  available_quantity DECIMAL(20,6) NOT NULL DEFAULT 0,
  frozen_quantity DECIMAL(20,6) NOT NULL DEFAULT 0,
  average_cost DECIMAL(20,4) NOT NULL DEFAULT 0,
  last_price DECIMAL(20,4) NULL,
  market_value DECIMAL(20,4) NOT NULL DEFAULT 0,
  realized_pnl DECIMAL(20,4) NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (account_id, instrument_key),
  KEY idx_pp_instrument (instrument_key),
  CONSTRAINT fk_pp_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_position_lots (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  instrument_key INT UNSIGNED NOT NULL,
  trade_date DATE NOT NULL,
  quantity DECIMAL(20,6) NOT NULL,
  available_quantity DECIMAL(20,6) NOT NULL DEFAULT 0,
  unit_cost DECIMAL(20,4) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_ppl_account_instrument_date (account_id, instrument_key, trade_date),
  CONSTRAINT fk_ppl_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_trades (
  id CHAR(36) NOT NULL PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  account_id CHAR(36) NOT NULL,
  instrument_key INT UNSIGNED NOT NULL,
  execution_run_id CHAR(36) NOT NULL,
  fill_sequence INT UNSIGNED NOT NULL,
  side VARCHAR(8) NOT NULL,
  quantity DECIMAL(20,6) NOT NULL,
  raw_price DECIMAL(20,4) NOT NULL,
  fill_price DECIMAL(20,4) NOT NULL,
  amount DECIMAL(20,4) NOT NULL,
  commission DECIMAL(20,4) NOT NULL,
  tax DECIMAL(20,4) NOT NULL,
  slippage_cost DECIMAL(20,4) NOT NULL,
  quote_time DATETIME(3) NOT NULL,
  quote_source VARCHAR(64) NOT NULL,
  rule_version VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY idx_pt_order_run_seq (order_id, execution_run_id, fill_sequence),
  KEY idx_pt_account_created (account_id, created_at),
  CONSTRAINT fk_pt_order FOREIGN KEY (order_id) REFERENCES paper_orders(id),
  CONSTRAINT fk_pt_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_cash_ledger (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  order_id CHAR(36) NULL,
  trade_id CHAR(36) NULL,
  event_type VARCHAR(32) NOT NULL,
  amount DECIMAL(20,4) NOT NULL,
  balance_after DECIMAL(20,4) NOT NULL,
  frozen_after DECIMAL(20,4) NOT NULL,
  description VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_pcl_account_created (account_id, created_at),
  KEY idx_pcl_order (order_id),
  CONSTRAINT fk_pcl_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_execution_runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  run_key VARCHAR(128) NOT NULL,
  trade_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL,
  quote_source VARCHAR(64) NULL,
  started_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  error_message VARCHAR(1000) NULL,
  UNIQUE KEY idx_per_run_key (run_key),
  KEY idx_per_date_status (trade_date, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  order_id CHAR(36) NULL,
  event_type VARCHAR(32) NOT NULL,
  event_payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_pal_account_created (account_id, created_at),
  KEY idx_pal_order_created (order_id, created_at),
  CONSTRAINT fk_pal_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
