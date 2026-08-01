ALTER TABLE multi_asset_plan_versions
  ADD INDEX idx_mapv_created (created_at);

ALTER TABLE multi_asset_runs
  ADD INDEX idx_mar_created (created_at);
