-- Phase 6.5: prevent scheduled experiments from reopening an old locked-test interval.

ALTER TABLE factor_mining_schedules
  ADD COLUMN last_test_end_date VARCHAR(10) NULL AFTER last_snapshot_id;
