ALTER TABLE multi_asset_runs
  ADD COLUMN worker_token VARCHAR(64) NULL AFTER progress,
  ADD COLUMN lease_expires_at VARCHAR(24) NULL AFTER worker_token,
  ADD COLUMN attempt_count INT NOT NULL DEFAULT 0 AFTER lease_expires_at,
  ADD INDEX idx_mar_status_lease (status, lease_expires_at);
