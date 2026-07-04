-- Tencent qfq/hfq prices require an affine transform for cash dividends:
-- adjusted_price = raw_price * factor + price_offset.

ALTER TABLE adjustment_factors_v2
  ADD COLUMN price_offset DOUBLE NOT NULL DEFAULT 0 AFTER factor;
