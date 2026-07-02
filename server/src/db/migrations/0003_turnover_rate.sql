ALTER TABLE candles
  ADD COLUMN turnover_rate_pct DOUBLE NULL AFTER turnover;

ALTER TABLE daily_candles
  ADD COLUMN turnover_rate_pct DOUBLE NULL AFTER turnover;
