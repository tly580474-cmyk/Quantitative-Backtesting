CREATE TABLE IF NOT EXISTS agent_approvals (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  thread_id VARCHAR(255) NOT NULL,
  turn_id VARCHAR(255) NOT NULL,
  item_id VARCHAR(255) NOT NULL,
  request_type VARCHAR(32) NOT NULL,
  summary TEXT NOT NULL,
  status ENUM('pending', 'approved', 'denied', 'expired', 'canceled') NOT NULL DEFAULT 'pending',
  expires_at DATETIME(3) NOT NULL,
  decision_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_agent_approvals_run_status (run_id, status),
  INDEX idx_agent_approvals_expiry (status, expires_at)
);

ALTER TABLE agent_events
  ADD COLUMN approval_json JSON NULL AFTER terminal_json;
