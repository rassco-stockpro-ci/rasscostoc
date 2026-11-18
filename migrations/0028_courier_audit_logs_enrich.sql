-- Enrich courier_audit_logs with actor snapshots, action metadata, and device context.
-- These columns already exist in production (added directly); this migration syncs local/staging.
ALTER TABLE "courier_audit_logs"
  ADD COLUMN IF NOT EXISTS "action_type" text,
  ADD COLUMN IF NOT EXISTS "action_description" text,
  ADD COLUMN IF NOT EXISTS "source" text,
  ADD COLUMN IF NOT EXISTS "status" text,
  ADD COLUMN IF NOT EXISTS "metadata" jsonb,
  ADD COLUMN IF NOT EXISTS "actor_name_snapshot" text,
  ADD COLUMN IF NOT EXISTS "actor_role_snapshot" text,
  ADD COLUMN IF NOT EXISTS "actor_avatar_url" text,
  ADD COLUMN IF NOT EXISTS "ip_address" text,
  ADD COLUMN IF NOT EXISTS "device_id" text;
