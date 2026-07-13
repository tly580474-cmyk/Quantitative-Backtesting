-- Persist the worker PID so cancellation survives API server restarts.

ALTER TABLE factor_mining_tasks
  ADD COLUMN worker_pid INT NULL AFTER finished_at;
