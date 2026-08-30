-- Retire the strategy iteration tables without changing the applied migration history.
-- Only feature-owned tables are removed; paper trading accounts and trades are retained.
DROP TABLE IF EXISTS factor_strategy_promotion_audits;
DROP TABLE IF EXISTS factor_strategy_paper_observations;
DROP TABLE IF EXISTS factor_strategy_evaluations;
DROP TABLE IF EXISTS factor_strategy_versions;
