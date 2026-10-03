/**
 * VALIDATION LAYER — PDF/report date-time extraction and normalization.
 *
 * Pure: reads pdf_reports.extracted_json (already populated by the installation bot's AI
 * extraction — see installation_bot.py's normalize_receipt_date_time/collect_receipt_date_time)
 * and normalizes it for comparison. No I/O, no guessing: unreadable or absent stays null, at
 * confidence 0.
 *
 * NOT a source-of-truth match. See CloseReportIdentityGuard and the "DATE/TIME SOURCE OF TRUTH"
 * finding: RASSCO has no trusted field for the installation/visit date or time —
 * courier_requests.date is the ticket's CREATION date (verified against Production: e.g. request
 * 2301's ticket date 2026-09-22, installed days/weeks later), and courier_executions.time /
 * delivery_date are this very close operation's own output, empty on virtually every closed
 * execution in Production history. The values this module extracts are therefore NEVER compared
 * against anything and NEVER block a close — they exist for display/audit (e.g. the portal's
 * pre-filled delivery date/time fields), not enforcement. DATE/TIME MATCH = UNVERIFIED until a
 * real, adopted business source for the visit's date/time exists.
 */

export interface ReceiptDateTimeFacts {
  date: string | null;
  dateConfidence: number; // 0-100
  time: string | null;
  timeConfidence: number; // 0-100
  retailerName: string | null;
  requestNumber: string | null;
}

/** YYYY-MM-DD, or null — never guessed/corrected. */
export function normalizeDate(v: string | null | undefined): string | null {
  const s = (v ?? "").toString().trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s || null;
}

/** HH:MM (minute precision — admin date/time pickers routinely drop the seconds a receipt has), or null. */
export function normalizeTime(v: string | null | undefined): string | null {
  const s = (v ?? "").toString().trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** Reads the facts this module extracts out of pdf_reports.extracted_json (a JSON string). Never throws. */
export function extractReceiptFacts(extractedJson: string | Record<string, unknown> | null | undefined): ReceiptDateTimeFacts {
  let parsed: any = {};
  try {
    parsed = typeof extractedJson === "string" ? JSON.parse(extractedJson || "{}") : extractedJson || {};
  } catch {
    parsed = {};
  }
  if (!parsed || typeof parsed !== "object") parsed = {}; // JSON.parse("null")/("42") succeed but are not an object
  const dateObj = parsed.date && typeof parsed.date === "object" ? parsed.date : {};
  const timeObj = parsed.time && typeof parsed.time === "object" ? parsed.time : {};
  const dateConfidence =
    typeof dateObj.confidence === "number"
      ? dateObj.confidence
      : typeof parsed.transaction_date_confidence === "number"
        ? Math.round(100 * parsed.transaction_date_confidence)
        : 0;
  const timeConfidence =
    typeof timeObj.confidence === "number"
      ? timeObj.confidence
      : typeof parsed.transaction_time_confidence === "number"
        ? Math.round(100 * parsed.transaction_time_confidence)
        : 0;
  const rawDate = parsed.transaction_date ?? dateObj.value ?? null;
  const rawTime = parsed.transaction_time ?? timeObj.value ?? null;
  return {
    date: normalizeDate(rawDate),
    dateConfidence: rawDate ? dateConfidence : 0,
    time: normalizeTime(rawTime),
    timeConfidence: rawTime ? timeConfidence : 0,
    retailerName: parsed.retailer_name?.value ?? null,
    requestNumber: parsed.request_number?.value ?? null,
  };
}
