CREATE TABLE IF NOT EXISTS agent_runs (
  id VARCHAR(36) PRIMARY KEY,
  prompt TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  max_turns INT NOT NULL DEFAULT 50,
  timeout_ms BIGINT NOT NULL DEFAULT 1800000,
  pid INT NULL,
  exit_code INT NULL,
  error_message VARCHAR(2000) NULL,
  created_at VARCHAR(24) NOT NULL,
  started_at VARCHAR(24) NULL,
  finished_at VARCHAR(24) NULL,
  INDEX idx_ar_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  seq INT NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  content TEXT NOT NULL,
  tool_name VARCHAR(64) NULL,
  tool_input TEXT NULL,
  tool_result TEXT NULL,
  created_at VARCHAR(24) NOT NULL,
  INDEX idx_ae_run_seq (run_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_reports (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  html_path VARCHAR(512) NOT NULL,
  file_size INT NULL,
  summary TEXT NULL,
  tags JSON NULL,
  charts_count INT DEFAULT 0,
  created_at VARCHAR(24) NOT NULL,
  INDEX idx_arep_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
