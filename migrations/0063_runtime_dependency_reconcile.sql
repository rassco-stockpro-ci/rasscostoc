-- Runtime dependency reconciliation — guarded, idempotent, additive.
--
-- Two objects that main's backend uses at runtime are created early in main's
-- chain (0001, 0004) but are absent from the Production database, whose schema
-- predates that chain. A database built from main already has both, so on it
-- every statement here is a no-op.
--
-- 1. tech_product_unique (main 0004): the ON CONFLICT target of
--    DrizzleTechnicianProductStockRepository.setBalance(). Without it,
--    POST /representative/inventory/sale fails on every call ("no unique or
--    exclusion constraint matching the ON CONFLICT specification").
--    Production's technician_product_stock is empty, so the index cannot fail
--    on duplicates there.
-- 2. idempotency_keys (main 0001): storage for the global idempotency
--    middleware. Without it, a request carrying x-idempotency-key is served
--    fail-open (no duplicate protection). No client in this repository sends
--    that header today. Same shape as 0001.
--
-- No row is read, inserted, updated or deleted. See
-- docs/migration-lineage-reconciliation.md.
CREATE UNIQUE INDEX IF NOT EXISTS "tech_product_unique"
  ON "technician_product_stock" USING btree ("technician_id", "product_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"key" varchar PRIMARY KEY NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"expires_at" timestamp NOT NULL
);
