CREATE TABLE IF NOT EXISTS factor_candidate_automation_settings (
  id VARCHAR(32) PRIMARY KEY,
  enabled TINYINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at VARCHAR(24) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO factor_candidate_automation_settings (id, enabled, updated_at)
VALUES ('default', 0, '1970-01-01T00:00:00.000Z');
