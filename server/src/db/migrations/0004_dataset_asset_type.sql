ALTER TABLE market_datasets
  ADD COLUMN asset_type VARCHAR(10) NOT NULL DEFAULT 'stock' AFTER symbol;

UPDATE market_datasets
SET asset_type = 'index'
WHERE UPPER(symbol) = 'NDX'
   OR name REGEXP '指数|沪深300|中证|上证|深证成指|创业板指|科创50|科创综指|纳斯达克100'
   OR source_file_name REGEXP '指数|沪深300|中证|上证|深证成指|创业板指|科创50|科创综指|纳斯达克100';
