-- 0038: Agent session_id and parent_run_id for conversation continuation
ALTER TABLE agent_runs
  ADD COLUMN session_id VARCHAR(128) NULL AFTER pid,
  ADD COLUMN parent_run_id VARCHAR(36) NULL AFTER session_id;
