-- Phase 5.5: avoid thousands of clustered lookups for daily cross sections.

ALTER TABLE daily_bars_v2
  DROP INDEX idx_dbv2_trade_date_instrument,
  ADD INDEX idx_dbv2_trade_date_instrument (
    trade_date,
    instrument_key,
    close,
    volume
  );
