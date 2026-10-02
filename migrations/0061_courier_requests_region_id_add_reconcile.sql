-- Lineage reconciliation — guarded, idempotent re-statement of 0055.
--
-- Why this exists: Production's migration ledger carries a high-water mark of
-- 1785826886000 (its own numbering shifted main's 0049-0054 by one). main's
-- 0055_courier_requests_region_id_add has exactly that `when`, and drizzle only
-- runs migrations whose `when` is STRICTLY GREATER than the last ledger row, so
-- 0055 is skipped on Production while 0056 (VALIDATE CONSTRAINT on the FK that
-- 0055 creates) is not — it would fail.
--
-- This entry sits in the journal between 0055 and 0056 with a `when` above the
-- Production high-water mark and below 0056's. Nothing existing is edited:
-- 0055 and 0056 keep their files and timestamps.
--
--   fresh database / main-migrated database: 0055 already ran, every statement
--     here is a no-op;
--   Production-shaped database: 0055 is skipped by the migrator, this entry
--     applies the same additive objects, then 0056 validates the FK.
--
-- Purely additive: a nullable column, an FK added NOT VALID (no row scan), one
-- index. No row is read or changed. See docs/migration-lineage-reconciliation.md.
ALTER TABLE "courier_requests" ADD COLUMN IF NOT EXISTS "region_id" varchar;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'courier_requests_region_id_regions_id_fk'
      AND conrelid = 'public.courier_requests'::regclass
  ) THEN
    ALTER TABLE "courier_requests"
      ADD CONSTRAINT "courier_requests_region_id_regions_id_fk"
      FOREIGN KEY ("region_id") REFERENCES "regions"("id") NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "courier_requests_region_id_idx"
  ON "courier_requests" ("region_id", "id" DESC);
