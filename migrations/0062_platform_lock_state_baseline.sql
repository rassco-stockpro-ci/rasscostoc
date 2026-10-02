-- Baseline for platform_lock_state (the platform lock / subscription state).
--
-- Until now this table existed only in Production, created outside the
-- migration chain, so a database built from main did not have it. This
-- migration gives every database the table in Production's real shape
-- (verified against a restored Production backup).
--
--   Production: the table already exists -> every statement is a no-op, no row
--     is read, inserted or changed.
--   Fresh database: the table is created, empty. The platform lock service
--     seeds its own single row on first use, so no seed row is inserted here.
--
-- Additive only. See docs/migration-lineage-reconciliation.md.
CREATE TABLE IF NOT EXISTS "platform_lock_state" (
	"id" varchar PRIMARY KEY DEFAULT 'default',
	"mode" text NOT NULL DEFAULT 'ACTIVE',
	"public_message" text,
	"internal_reason" text,
	"locked_at" timestamp,
	"locked_by" text,
	"subscription_expires_at" timestamp,
	"grace_period_ends_at" timestamp,
	"stop_workers" boolean NOT NULL DEFAULT true,
	"revoke_sessions" boolean NOT NULL DEFAULT true,
	"system_lock_version" integer NOT NULL DEFAULT 0,
	"suspended_at" timestamp,
	"reactivated_at" timestamp,
	"suspension_reason" text,
	"updated_at" timestamp DEFAULT now()
);
