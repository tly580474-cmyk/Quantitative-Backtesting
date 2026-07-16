ALTER TABLE index_constituent_snapshots
  ADD COLUMN weight_method VARCHAR(32) NOT NULL DEFAULT 'official' AFTER source_file_checksum,
  ADD COLUMN anchor_snapshot_id VARCHAR(36) NULL AFTER weight_method,
  ADD COLUMN validation_snapshot_id VARCHAR(36) NULL AFTER anchor_snapshot_id,
  ADD COLUMN validation_half_l1_pct DOUBLE NULL AFTER validation_snapshot_id;
