-- ERP-INV-001: Track inventory deduction status per execution.
-- PENDING  = execution completed, outbox event published, waiting for subscriber
-- COMPLETED = inventory deducted successfully
-- FAILED   = deduction attempted but engine returned errors (saga reverts to "In Progress")
-- SKIPPED  = execution has no resolvable serials (legitimate skip, not an error)
-- REQUEUED = reconciliation re-enqueued the event; subscriber will update to final status
ALTER TABLE "courier_executions"
  ADD COLUMN IF NOT EXISTS "deduction_status" varchar(20);

-- Index for the reconciliation worker's PENDING query
CREATE INDEX IF NOT EXISTS courier_executions_deduction_status_idx
  ON courier_executions (deduction_status)
  WHERE deduction_status IS NOT NULL;
