/**
 * BUSINESS MATCH LAYER — blocks a PDF-report completion (completePdfReport,
 * POST /api/courier/pdf/:id/complete — the ONLY path this guards; the manual/direct
 * courier_executions close, saveExecution, has no report to check against and is untouched) only on
 * checks RASSCO has a TRUSTED source for: does the report's claimed customer name and request
 * number match the request actually being closed.
 *
 * Scope boundary: this proves ONLY Request Number + Customer Name. It does not claim to validate
 * every field of the form — Date/Time (see receipt-datetime-extraction.ts, informational, never
 * blocking — RASSCO has no trusted field for the installation/visit date or time; courier_requests
 * .date is the ticket's CREATION date, courier_executions.time/delivery_date are this very
 * operation's own output and empty on virtually every closed execution in Production history),
 * Terminal ID, TID and any other form field stay governed by their own existing contracts until a
 * truth source and matching rule is defined for each independently.
 *
 * Customer name and request number ARE checked against the request actually being closed
 * (`request`, i.e. the real RASSCO record for `requestId`) — the "does this report even belong to
 * this request" check, catching a report linked to the wrong request. The extracted values are
 * compared against every column match_request_by_number (the bot's own request-matching query, in
 * installation_bot.py) searches, not one assumed field: id, incidentNumber, tid, terminalId for the
 * number; customerName OR retailerName for the name (match_request_by_number returns both, and the
 * bot prefers customer_name — see update_rassco_extracted_json). No new source is invented.
 *
 * Normalization before comparing the customer name: trim, collapse repeated whitespace, and
 * Unicode-normalize (NFKC — shape/compatibility variants only, e.g. presentation-form characters
 * folded to their base form). Never fuzzy: no word is dropped or substituted, so "مؤسسة أحمد علي"
 * and "مؤسسة  أحمد   علي" (extra spaces) match, but "مؤسسة أحمد علي" and "مؤسسة أحمد صالح" (a real
 * difference) do not.
 *
 * A rejection writes one audit row before throwing — same contract as CustodyGuard's own
 * writeAuditFailure (tableName "executions", fieldName "status", action "verification_failed") —
 * and nothing else: no execution write, no deduction, no CLOSED_SUCCESS, no outbox event.
 */
import { ReportIdentityMismatchError } from "@core/errors/AppError";
import type { ReceiptDateTimeFacts } from "../receipt-datetime-extraction";
import type { GuardRejectionAudit } from "./guard.types";

export interface CloseReportIdentityGuardRequest {
  id: number;
  customerName?: string | null;
  retailerName?: string | null;
  incidentNumber?: string | null;
  tid?: string | null;
  terminalId?: string | null;
}

export interface CloseReportIdentityGuardContext {
  requestId: number;
  enteredBy: string;
  dashboardRepo: GuardRejectionAudit;
}

/** Trim + collapse whitespace + Unicode shape-normalize (NFKC) + case-fold. Never fuzzy: no word is dropped. */
function normalizeForMatch(v: string | null | undefined): string {
  return (v ?? "")
    .toString()
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export class CloseReportIdentityGuard {
  /**
   * @throws ReportIdentityMismatchError (422) on the first check that fails, after writing the
   * rejection's audit row. No other write happens, on either the pass or the fail path — this
   * guard itself never saves anything but that one audit row.
   */
  static async assert(
    facts: Pick<ReceiptDateTimeFacts, "retailerName" | "requestNumber">,
    request: CloseReportIdentityGuardRequest,
    ctx: CloseReportIdentityGuardContext
  ): Promise<void> {
    const extractedCustomer = normalizeForMatch(facts.retailerName);
    const requestCustomerCandidates = [request.customerName, request.retailerName].map(normalizeForMatch).filter(Boolean);
    if (!extractedCustomer || !requestCustomerCandidates.includes(extractedCustomer)) {
      await this.writeAuditFailure(ctx, `اسم العميل في التقرير لا يطابق اسم العميل في الطلب رقم ${ctx.requestId}`);
      throw new ReportIdentityMismatchError(
        "CUSTOMER_MISMATCH",
        "اسم العميل في بيانات التقرير المستخرجة لا يطابق اسم العميل في الطلب المراد إغلاقه."
      );
    }

    const extractedRequestNumber = normalizeForMatch(facts.requestNumber);
    const requestNumberCandidates = [request.id != null ? String(request.id) : null, request.incidentNumber, request.tid, request.terminalId]
      .map(normalizeForMatch)
      .filter(Boolean);
    if (!extractedRequestNumber || !requestNumberCandidates.includes(extractedRequestNumber)) {
      await this.writeAuditFailure(ctx, `رقم الطلب في التقرير لا يطابق الطلب رقم ${ctx.requestId}`);
      throw new ReportIdentityMismatchError(
        "REQUEST_NUMBER_MISMATCH",
        "رقم الطلب في بيانات التقرير المستخرجة لا يطابق الطلب المراد إغلاقه."
      );
    }
  }

  /** Same convention as CustodyGuard.writeAuditFailure: best-effort, never masks the real rejection. */
  private static async writeAuditFailure(ctx: CloseReportIdentityGuardContext, reason: string): Promise<void> {
    try {
      await ctx.dashboardRepo.insertAuditLog({
        tableName: "executions",
        recordId: ctx.requestId,
        fieldName: "status",
        oldValue: null,
        newValue: `فشل التحقق: ${reason}`,
        action: "verification_failed",
        changedBy: ctx.enteredBy,
      });
    } catch {
      // Non-critical
    }
  }
}
