-- Repair databases where the old migration parser skipped the first CREATE
-- statement in 0001_phase5.sql because the file began with comments.
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
