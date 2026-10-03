-- Deleting an uploaded courier PDF report (admin-only, DELETE /api/courier/pdf/:id) removes the
-- courier_pdf_reports row immediately (so it stops showing in the UI/lists), but the Drive file
-- and the installation bot's local dedupe hashes can only be cleaned up by the bot itself — the
-- backend holds no Google credentials. This table is the work queue between the two: the backend
-- enqueues one row per deletion, and the bot polls it (POST /api/courier/pdf/deletion-tasks/claim,
-- internal-service-key only) to delete the original PDF from Drive and release the whole-file and
-- per-page hashes it recorded in its own processed_files table, so the exact same report can be
-- scanned and uploaded again without "تم رفعه ومعالجته مسبقًا".
--
-- No FK to courier_pdf_reports.id: the report row this task was created for is deleted in the same
-- transaction that inserts this row (ON DELETE CASCADE would delete the task itself; ON DELETE SET
-- NULL would lose which report this was). report_id is kept purely for audit/debugging.
--
-- status: PENDING (not yet claimed) -> CLAIMED (a bot poll is working on it, with a lease so a
-- crashed bot doesn't strand it forever) -> DONE (confirmed) or FAILED (gave up after repeated
-- failures - see attempts). A CLAIMED row whose lease has expired is eligible to be claimed again.
--
-- Rollback:
--   DROP TABLE IF EXISTS "courier_pdf_deletion_tasks";
CREATE TABLE IF NOT EXISTS "courier_pdf_deletion_tasks" (
  "id" serial PRIMARY KEY,
  "report_id" integer NOT NULL,
  "drive_url" text,
  "file_name" text,
  "requested_by" varchar REFERENCES "users"("id"),
  "requested_at" timestamp DEFAULT now() NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0,
  "leased_until" timestamp,
  "completed_at" timestamp,
  "last_error" text,
  CONSTRAINT "courier_pdf_deletion_tasks_status_check" CHECK ("status" IN ('PENDING', 'CLAIMED', 'DONE', 'FAILED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courier_pdf_deletion_tasks_status_idx" ON "courier_pdf_deletion_tasks" ("status");
