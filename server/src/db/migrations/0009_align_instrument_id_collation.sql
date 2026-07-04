-- Phase 5.5: align the public instrument ID with Phase 5 relation columns.

ALTER TABLE instruments
  MODIFY COLUMN id VARCHAR(36)
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci
    NOT NULL;
