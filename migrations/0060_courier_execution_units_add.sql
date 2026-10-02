-- Multi-Device / Multi-SIM — M1 (additive only, no behavior change on its own).
--
-- courier_execution_units: one row per installed terminal of a close
-- ("installation unit"): exactly one device, at most one SIM (or an explicit
-- waiver), optional TID. The unit IS the Device<->SIM pairing; it is written
-- only inside the close transaction (CloseRequestUseCase.commit) and never
-- updated afterwards.
--
-- courier_request_items.execution_unit_id links an INSTALLED request item to
-- the unit it was installed in; item_id replaces the dead integer column
-- inventory_item_id (items.id is a varchar UUID). inventory_item_id is left
-- untouched during the transition period.
--
-- Rollback: DROP TABLE courier_execution_units CASCADE; ALTER TABLE
-- courier_request_items DROP COLUMN execution_unit_id, DROP COLUMN item_id;
-- DROP INDEX courier_request_items_request_idx.
CREATE TABLE IF NOT EXISTS "courier_execution_units" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"execution_id" integer NOT NULL,
	"unit_no" integer NOT NULL,
	"device_item_id" varchar NOT NULL,
	"device_serial" text NOT NULL,
	"sim_item_id" varchar,
	"sim_serial" text,
	"sim_waived" boolean DEFAULT false NOT NULL,
	"tid" text,
	"pairing_source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "courier_execution_units_request_unit_no_uq" UNIQUE("request_id","unit_no"),
	CONSTRAINT "courier_execution_units_request_device_uq" UNIQUE("request_id","device_item_id"),
	CONSTRAINT "courier_execution_units_unit_no_positive_check" CHECK ("unit_no" >= 1),
	CONSTRAINT "courier_execution_units_pairing_source_check" CHECK ("pairing_source" IN ('EXPLICIT', 'LEGACY_INFERRED', 'LEGACY_BACKFILL')),
	CONSTRAINT "courier_execution_units_sim_consistency_check" CHECK (
		("sim_item_id" IS NULL AND "sim_serial" IS NULL AND "sim_waived")
		OR ("sim_item_id" IS NOT NULL AND "sim_serial" IS NOT NULL AND NOT "sim_waived")
	),
	CONSTRAINT "courier_execution_units_device_ne_sim_check" CHECK ("sim_item_id" IS NULL OR "sim_item_id" <> "device_item_id")
);
--> statement-breakpoint
ALTER TABLE "courier_execution_units" ADD CONSTRAINT "courier_execution_units_request_id_courier_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."courier_requests"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "courier_execution_units" ADD CONSTRAINT "courier_execution_units_execution_id_courier_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."courier_executions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "courier_execution_units" ADD CONSTRAINT "courier_execution_units_device_item_id_items_id_fk" FOREIGN KEY ("device_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "courier_execution_units" ADD CONSTRAINT "courier_execution_units_sim_item_id_items_id_fk" FOREIGN KEY ("sim_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "courier_execution_units_request_sim_uq" ON "courier_execution_units" ("request_id","sim_item_id") WHERE "sim_item_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courier_execution_units_execution_idx" ON "courier_execution_units" ("execution_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courier_execution_units_device_serial_idx" ON "courier_execution_units" ("device_serial");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courier_execution_units_sim_serial_idx" ON "courier_execution_units" ("sim_serial");
--> statement-breakpoint
ALTER TABLE "courier_request_items" ADD COLUMN IF NOT EXISTS "execution_unit_id" integer;
--> statement-breakpoint
ALTER TABLE "courier_request_items" ADD COLUMN IF NOT EXISTS "item_id" varchar;
--> statement-breakpoint
ALTER TABLE "courier_request_items" ADD CONSTRAINT "courier_request_items_execution_unit_id_courier_execution_units_id_fk" FOREIGN KEY ("execution_unit_id") REFERENCES "public"."courier_execution_units"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "courier_request_items" ADD CONSTRAINT "courier_request_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courier_request_items_request_idx" ON "courier_request_items" ("request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courier_request_items_execution_unit_idx" ON "courier_request_items" ("execution_unit_id");
