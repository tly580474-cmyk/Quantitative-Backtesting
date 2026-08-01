CREATE TABLE IF NOT EXISTS multi_asset_workers (
  id VARCHAR(36) PRIMARY KEY,
  mode VARCHAR(16) NOT NULL,
  hostname VARCHAR(255) NOT NULL,
  pid INT NOT NULL,
  concurrency INT NOT NULL,
  status VARCHAR(16) NOT NULL,
  started_at VARCHAR(24) NOT NULL,
  last_heartbeat_at VARCHAR(24) NOT NULL,
  stopped_at VARCHAR(24) NULL,
  metadata JSON NULL,
  INDEX idx_maw_status_heartbeat (status, last_heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
