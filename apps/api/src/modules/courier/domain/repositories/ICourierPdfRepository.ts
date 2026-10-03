import type { CourierPdfReport, PdfReportFilters } from "../courier.types";

export interface CourierPdfDeletionTask {
  id: number;
  reportId: number;
  driveUrl: string | null;
  fileName: string | null;
  requestedBy: string | null;
  requestedAt: Date;
  status: "PENDING" | "CLAIMED" | "DONE" | "FAILED";
  attempts: number;
  leasedUntil: Date | null;
  completedAt: Date | null;
  lastError: string | null;
}

export interface ICourierPdfRepository {
  findPdfReportById(id: number, tx?: any): Promise<CourierPdfReport | null>;
  listPdfReports(filters?: PdfReportFilters, tx?: any): Promise<CourierPdfReport[]>;
  insertPdfReport(data: any, tx?: any): Promise<CourierPdfReport>;
  updatePdfReport(id: number, data: any, tx?: any): Promise<CourierPdfReport>;
  /**
   * OPS-REMED-E12 (E1+E2): atomically transitions a pdf_reports row from
   * `expectedStatus` to `newStatus` via `UPDATE ... WHERE status = $expected
   * RETURNING *`. Returns null (never throws) when the row's status was
   * NOT `expectedStatus` at the moment of the update — meaning another
   * concurrent approval/rejection/completion already won the race. No
   * explicit `tx` parameter: when called through a
   * `DrizzleCourierUnitOfWork`-constructed repository instance, the
   * transaction is already bound to the instance via its constructor.
   */
  claimPdfReportForTransition(
    pdfId: number,
    expectedStatus: string,
    newStatus: string
  ): Promise<CourierPdfReport | null>;

  /**
   * Locks the pdf_reports row (`SELECT ... FOR UPDATE`, this table only —
   * no joins, so no other table's rows are locked) so a concurrent
   * apply/reject CAS and a delete can never both act on the same row:
   * whichever transaction commits first wins, the other sees the
   * post-commit state. Called only from inside `uow.execute`, never
   * standalone, since a row lock outside a transaction is released
   * immediately and would not protect anything.
   */
  lockPdfReportById(id: number): Promise<CourierPdfReport | null>;

  /** Hard delete — courier_pdf_reports has no incoming foreign keys. */
  deletePdfReportRow(id: number): Promise<void>;

  /**
   * Enqueues the Drive-file-and-hash cleanup for a report the admin just
   * deleted. No FK to the report row (which is typically deleted in the
   * same transaction) — see migration 0065.
   */
  insertPdfDeletionTask(data: {
    reportId: number;
    driveUrl: string | null;
    fileName: string | null;
    requestedBy: string;
  }): Promise<CourierPdfDeletionTask>;

  /**
   * Atomically claims the oldest eligible task (PENDING, or CLAIMED with
   * an expired lease, capped at 5 attempts) via
   * `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`,
   * so two concurrent bot polls can never claim the same task. Returns
   * null when no task is eligible.
   */
  claimNextPdfDeletionTask(): Promise<CourierPdfDeletionTask | null>;

  /**
   * Bot acknowledgment: success marks the task DONE; failure resets it to
   * PENDING for an immediate retry on the next poll, unless the attempt
   * cap has been reached, in which case it is marked FAILED instead of
   * being retried forever.
   */
  completePdfDeletionTask(id: number, success: boolean, error?: string): Promise<CourierPdfDeletionTask | null>;
}
