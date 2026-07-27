-- 0031_paper_trading_phase2.sql
-- Phase 2: 策略绑定、风控配置与权益快照持久化

CREATE TABLE IF NOT EXISTS paper_strategy_bindings (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  strategy_id VARCHAR(128) NOT NULL,
  strategy_name VARCHAR(255) NOT NULL,
  params JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'paused',
  -- paused | active | stopped | error
  last_evaluated_at DATETIME(3) NULL,
  last_signal JSON NULL,
  last_error VARCHAR(1000) NULL,
  -- 当日已生成交易意图的幂等键，用于防止重复下单
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
  -- 单股最大仓位（占账户总权益的比例，0~1），NULL 表示不限
  max_single_position_ratio DECIMAL(8,6) NULL,
  -- 账户最大总仓位（占账户总权益的比例，0~1），NULL 表示不限
  max_total_position_ratio DECIMAL(8,6) NULL,
  -- 单笔委托最大金额（元），NULL 表示不限
  max_order_amount DECIMAL(20,4) NULL,
  -- 单日最大成交金额（元），NULL 表示不限
  max_daily_turnover DECIMAL(20,4) NULL,
  -- 单日最大委托数量，NULL 表示不限
  max_daily_orders INT UNSIGNED NULL,
  -- 账户最大回撤（占初始资金的比例，0~1），NULL 表示不限
  max_drawdown_ratio DECIMAL(8,6) NULL,
  -- 单日最大亏损（元），NULL 表示不限
  max_daily_loss DECIMAL(20,4) NULL,
  -- 风控规则版本
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
  -- 累计收益率（占初始资金比例）
  return_ratio DECIMAL(12,8) NOT NULL,
  -- 当日收益率（占前一日总权益比例）
  daily_return_ratio DECIMAL(12,8) NULL,
  -- 截至当日的最大回撤（占历史峰值权益比例，正数）
  max_drawdown_ratio DECIMAL(12,8) NULL,
  -- 历史峰值权益
  peak_equity DECIMAL(20,4) NULL,
  -- 基准代码（例如沪深300指数代码），NULL 表示无基准
  benchmark_code VARCHAR(20) NULL,
  benchmark_close DECIMAL(20,4) NULL,
  -- 触发风控的拒绝事件计数
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
  -- 触发时的指标快照
  metric_snapshot JSON NOT NULL,
  -- 拒绝原因人类可读描述
  reason VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_pre_account_created (account_id, created_at),
  KEY idx_pre_rule (rule_code, created_at),
  CONSTRAINT fk_pre_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
