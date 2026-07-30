CREATE TABLE IF NOT EXISTS factor_strategy_versions (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  parent_version_id VARCHAR(36) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  factor_versions JSON NOT NULL,
  composite_weights JSON NOT NULL,
  universe_config JSON NOT NULL,
  preprocessing_config JSON NOT NULL,
  optimizer_config JSON NOT NULL,
  cost_config JSON NOT NULL,
  snapshot_id VARCHAR(128) NOT NULL,
  code_checksum VARCHAR(64) NOT NULL,
  random_seeds JSON NOT NULL,
  paper_account_id VARCHAR(36) NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  INDEX idx_fsv_status_updated (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS factor_strategy_evaluations (
  id VARCHAR(36) PRIMARY KEY,
  strategy_version_id VARCHAR(36) NOT NULL,
  evaluation_type VARCHAR(24) NOT NULL,
  metrics JSON NOT NULL,
  gate_result JSON NOT NULL,
  artifact_uri VARCHAR(1024) NULL,
  created_at VARCHAR(24) NOT NULL,
  INDEX idx_fse_version_created (strategy_version_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS factor_strategy_paper_observations (
  id VARCHAR(36) PRIMARY KEY,
  strategy_version_id VARCHAR(36) NOT NULL,
  rebalance_cycle INT NOT NULL,
  observation_date VARCHAR(10) NOT NULL,
  metrics JSON NOT NULL,
  violations JSON NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_fspo_version_cycle (strategy_version_id, rebalance_cycle)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS factor_strategy_promotion_audits (
  id VARCHAR(36) PRIMARY KEY,
  strategy_version_id VARCHAR(36) NOT NULL,
  prior_champion_id VARCHAR(36) NULL,
  decision VARCHAR(16) NOT NULL,
  approved_by VARCHAR(128) NOT NULL,
  reason VARCHAR(1000) NULL,
  gate_result JSON NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  INDEX idx_fspa_version_created (strategy_version_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
