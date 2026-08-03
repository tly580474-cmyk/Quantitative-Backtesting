ALTER TABLE agent_runs ADD COLUMN template_style VARCHAR(24) NOT NULL DEFAULT 'classic-blue' AFTER max_turns;
