CREATE TABLE IF NOT EXISTS agent_attachments (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NULL,
  original_name VARCHAR(255) NOT NULL,
  media_type VARCHAR(127) NOT NULL,
  file_kind ENUM('image', 'document', 'text', 'spreadsheet') NOT NULL,
  extension VARCHAR(16) NOT NULL,
  file_size BIGINT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  stored_path VARCHAR(512) NOT NULL,
  extracted_path VARCHAR(512) NULL,
  extracted_chars INT NOT NULL DEFAULT 0,
  created_at VARCHAR(24) NOT NULL,
  INDEX idx_agent_attachments_run (run_id),
  INDEX idx_agent_attachments_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
