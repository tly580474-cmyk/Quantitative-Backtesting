-- Existing Claude sessions belong to the retired runtime and remain readable.
-- New application versions always write provider_runtime explicitly.
ALTER TABLE agent_runs
  ADD COLUMN provider_runtime VARCHAR(16) NOT NULL DEFAULT 'legacy' AFTER provider;

UPDATE agent_runs SET provider_runtime = 'native' WHERE provider = 'codex';
