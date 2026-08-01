CREATE TABLE IF NOT EXISTS strategy_experiment_validation_policies (
  id VARCHAR(36) PRIMARY KEY,
  version VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  config JSON NOT NULL,
  config_hash VARCHAR(64) NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_sevp_version (version),
  INDEX idx_sevp_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_experiment_validation_plans (
  id VARCHAR(36) PRIMARY KEY,
  experiment_version_id VARCHAR(36) NOT NULL,
  policy_id VARCHAR(36) NOT NULL,
  sample_plan JSON NOT NULL,
  perturbation_plan JSON NOT NULL,
  plan_hash VARCHAR(64) NOT NULL,
  locked_test_status VARCHAR(16) NOT NULL DEFAULT 'sealed',
  locked_test_opened_at VARCHAR(24) NULL,
  locked_test_open_token VARCHAR(64) NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_sevplan_version (experiment_version_id),
  UNIQUE INDEX idx_sevplan_hash (plan_hash),
  UNIQUE INDEX idx_sevplan_open_token (locked_test_open_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_experiment_gate_evaluations (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  policy_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL,
  checks JSON NOT NULL,
  metrics_snapshot JSON NOT NULL,
  calculator_version VARCHAR(64) NOT NULL,
  evaluation_hash VARCHAR(64) NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_sege_run_policy (run_id, policy_id),
  UNIQUE INDEX idx_sege_hash (evaluation_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_experiment_reports (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  template_version VARCHAR(64) NOT NULL,
  structured_report JSON NOT NULL,
  markdown MEDIUMTEXT NOT NULL,
  report_hash VARCHAR(64) NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_serpt_run_template (run_id, template_version),
  UNIQUE INDEX idx_serpt_hash (report_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_experiment_artifact_jobs (
  id VARCHAR(36) PRIMARY KEY,
  report_id VARCHAR(36) NOT NULL,
  format VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  cache_key VARCHAR(128) NOT NULL,
  artifact_uri VARCHAR(1024) NULL,
  error_message VARCHAR(1000) NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at VARCHAR(24) NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_seaj_cache (cache_key),
  INDEX idx_seaj_status_created (status, created_at),
  INDEX idx_seaj_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE strategy_experiment_runs
  ADD COLUMN validation_status VARCHAR(16) NULL AFTER result_hash,
  ADD COLUMN validation_policy_version VARCHAR(64) NULL AFTER validation_status;
