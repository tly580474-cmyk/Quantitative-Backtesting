-- Agent protocol v2: conversation paging, immutable terminal state and replay-safe events.
ALTER TABLE agent_runs
  ADD COLUMN conversation_id VARCHAR(36) NULL AFTER parent_run_id,
  ADD COLUMN turn_index INT NOT NULL DEFAULT 0 AFTER conversation_id,
  ADD COLUMN error_code VARCHAR(64) NULL AFTER error_message,
  ADD COLUMN protocol_version INT NOT NULL DEFAULT 1 AFTER error_code;

UPDATE agent_runs SET conversation_id = id WHERE conversation_id IS NULL;

WITH RECURSIVE conversation_tree AS (
  SELECT id, id AS root_id, 0 AS depth FROM agent_runs WHERE parent_run_id IS NULL
  UNION ALL
  SELECT child.id, tree.root_id, tree.depth + 1
  FROM agent_runs child JOIN conversation_tree tree ON child.parent_run_id = tree.id
  WHERE tree.depth < 199
)
UPDATE agent_runs run
JOIN conversation_tree tree ON tree.id = run.id
SET run.conversation_id = tree.root_id, run.turn_index = tree.depth;

ALTER TABLE agent_runs
  MODIFY conversation_id VARCHAR(36) NOT NULL,
  ADD INDEX idx_ar_conversation_turn (conversation_id, turn_index),
  ADD INDEX idx_ar_conversation_created (conversation_id, created_at),
  ADD INDEX idx_ar_parent_run (parent_run_id);

ALTER TABLE agent_events
  ADD COLUMN tool_use_id VARCHAR(128) NULL AFTER tool_name,
  ADD COLUMN duration_ms BIGINT NULL AFTER tool_use_id,
  ADD COLUMN terminal_json JSON NULL AFTER duration_ms,
  ADD COLUMN protocol_version INT NOT NULL DEFAULT 1 AFTER terminal_json,
  DROP INDEX idx_ae_run_seq,
  ADD UNIQUE INDEX idx_ae_run_seq (run_id, seq);

ALTER TABLE agent_events
  ADD CONSTRAINT fk_agent_events_run FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE;

ALTER TABLE agent_reports
  ADD CONSTRAINT fk_agent_reports_run FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE;
