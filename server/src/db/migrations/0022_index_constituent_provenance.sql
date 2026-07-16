ALTER TABLE index_constituent_snapshots
  ADD COLUMN source_url VARCHAR(1024) NULL AFTER source_checksum,
  ADD COLUMN source_captured_at DATETIME NULL AFTER source_url,
  ADD COLUMN source_file_checksum VARCHAR(64) NULL AFTER source_captured_at;
