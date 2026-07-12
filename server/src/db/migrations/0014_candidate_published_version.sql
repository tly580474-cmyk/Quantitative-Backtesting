-- Phase 6.5: preserve the formal factor version created from an approved candidate.

ALTER TABLE factor_candidates
  ADD COLUMN published_factor_version_id VARCHAR(96) NULL AFTER factor_run_id;
