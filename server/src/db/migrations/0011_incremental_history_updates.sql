-- Incremental authoritative history updates and per-instrument factor publishing.

ALTER TABLE daily_bars_v2
  ADD COLUMN is_final TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER fetched_at;

CREATE TABLE IF NOT EXISTS adjustment_factor_publications (
  instrument_key INT UNSIGNED NOT NULL PRIMARY KEY,
  factor_version VARCHAR(32) NOT NULL,
  source_batch_id VARCHAR(36) NOT NULL,
  source_fingerprint VARCHAR(64) NOT NULL,
  last_checked_date DATE NOT NULL,
  published_at DATETIME(3) NOT NULL,
  INDEX idx_afp_published (published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS corporate_actions (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  instrument_key INT UNSIGNED NOT NULL,
  ex_date DATE NOT NULL,
  action_type VARCHAR(32) NOT NULL DEFAULT 'unknown',
  previous_close DOUBLE NULL,
  ex_reference_price DOUBLE NULL,
  source_key INT UNSIGNED NOT NULL DEFAULT 1,
  source_fingerprint VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'confirmed',
  detected_at DATETIME(3) NOT NULL,
  UNIQUE INDEX idx_ca_instrument_date (instrument_key, ex_date),
  INDEX idx_ca_ex_date (ex_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO adjustment_factor_publications (
  instrument_key, factor_version, source_batch_id, source_fingerprint,
  last_checked_date, published_at
)
SELECT ranked.instrument_key,
       ranked.factor_version,
       ranked.source_batch_id,
       ranked.source_snapshot,
       DATE(ranked.published_at),
       ranked.published_at
FROM (
  SELECT af.instrument_key,
         af.factor_version,
         af.source_batch_id,
         dib.source_snapshot,
         dib.published_at,
         ROW_NUMBER() OVER (
           PARTITION BY af.instrument_key
           ORDER BY dib.published_at DESC
         ) AS row_number_in_instrument
  FROM adjustment_factors_v2 af
  INNER JOIN data_import_batches dib
    ON dib.id = af.source_batch_id
  WHERE dib.published_at IS NOT NULL
) ranked
WHERE ranked.row_number_in_instrument = 1
ON DUPLICATE KEY UPDATE
  factor_version = VALUES(factor_version),
  source_batch_id = VALUES(source_batch_id),
  source_fingerprint = VALUES(source_fingerprint),
  last_checked_date = VALUES(last_checked_date),
  published_at = VALUES(published_at);
