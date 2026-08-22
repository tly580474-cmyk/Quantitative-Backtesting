-- Additive and rollback-compatible: older application versions ignore this column.
ALTER TABLE agent_runs
  ADD COLUMN provider VARCHAR(16) NOT NULL DEFAULT 'claude' AFTER pid;

CREATE INDEX idx_ar_conversation_provider ON agent_runs(conversation_id, provider);
