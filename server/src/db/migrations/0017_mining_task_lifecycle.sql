-- Allow terminal mining tasks to be archived/restored or logically deleted.

ALTER TABLE factor_mining_tasks
  ADD COLUMN archived_at VARCHAR(24) NULL AFTER finished_at,
  ADD COLUMN deleted_at VARCHAR(24) NULL AFTER archived_at,
  ADD INDEX idx_fmt_archive_created (archived_at, deleted_at, created_at);
