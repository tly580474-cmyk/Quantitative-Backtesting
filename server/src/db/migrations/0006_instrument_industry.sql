-- Phase 5.5: retain the source industry classification on instruments.

ALTER TABLE instruments
  ADD COLUMN industry VARCHAR(128) NULL AFTER name;
