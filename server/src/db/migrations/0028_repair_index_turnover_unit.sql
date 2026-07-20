-- Legacy Candle.turnover is expressed in CNY 100m (亿元). Older index
-- importers persisted provider amounts in yuan. Values above one million 亿
-- unambiguously identify those rows without touching valid imported datasets.
UPDATE candles AS c
INNER JOIN market_datasets AS d ON d.id = c.dataset_id
SET c.turnover = c.turnover / 100000000
WHERE d.asset_type = 'index'
  AND c.turnover >= 1000000;
