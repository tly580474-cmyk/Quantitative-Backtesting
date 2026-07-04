-- Phase 5.5: a batch may complete while isolating invalid source files.

ALTER TABLE data_import_batches
  ADD COLUMN failed_files INT NOT NULL DEFAULT 0 AFTER completed_files;
