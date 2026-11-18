-- Add index on outbox_events(status, created_at) for outbox worker performance
CREATE INDEX IF NOT EXISTS outbox_events_status_created_idx
  ON outbox_events (status, created_at ASC);
