/**
 * VALIDATION LAYER — PDF/report date-time extraction and normalization. Pure functions, no DB, no
 * HTTP: proves extraction reads what's there and never guesses what isn't.
 *
 * This is deliberately NOT a match/enforcement test — see close-report-identity-gate.test.ts and
 * CloseReportIdentityGuard for why date/time are extracted here but never compared against
 * anything (RASSCO has no trusted source for the installation/visit date or time).
 */
import { describe, expect, it } from "vitest";
import { extractReceiptFacts, normalizeDate, normalizeTime } from "./receipt-datetime-extraction";

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    date: { value: "2026-07-12", confidence: 93, source: "ai_engine" },
    time: { value: "17:55:43", confidence: 93, source: "ai_engine" },
    transaction_date: "2026-07-12",
    transaction_time: "17:55:43",
    retailer_name: { value: "متجر الأمانة", confidence: 95, source: "ai_engine" },
    request_number: { value: "2301", confidence: 95, source: "ai_engine" },
    ...overrides,
  });
}

describe("extractReceiptFacts — reads what the bot extracted, never guesses", () => {
  it("reads a fully populated extraction", () => {
    const facts = extractReceiptFacts(payload());
    expect(facts).toMatchObject({
      date: "2026-07-12",
      dateConfidence: 93,
      time: "17:55",
      timeConfidence: 93,
      retailerName: "متجر الأمانة",
      requestNumber: "2301",
    });
  });

  it("a null date/time (the bot could not read it) stays null, confidence 0 — never guessed", () => {
    const facts = extractReceiptFacts(
      JSON.stringify({ date: { value: null, confidence: 0 }, time: { value: null, confidence: 0 } })
    );
    expect(facts.date).toBeNull();
    expect(facts.dateConfidence).toBe(0);
    expect(facts.time).toBeNull();
    expect(facts.timeConfidence).toBe(0);
  });

  it("a present value with confidence 0 is NOT treated as confidently read", () => {
    const facts = extractReceiptFacts(payload({ date: { value: "2026-07-12", confidence: 0 } }));
    expect(facts.date).toBe("2026-07-12"); // the value itself is still reported...
    expect(facts.dateConfidence).toBe(0); // ...but confidence correctly reflects it was not a confident read
  });

  it("a stray nonzero confidence next to a MISSING value is forced to 0 — confidence never implies a reading that is not there", () => {
    // no top-level transaction_date/transaction_time fallback here, unlike payload() — isolates dateObj/timeObj alone
    const facts = extractReceiptFacts(JSON.stringify({ date: { value: null, confidence: 90 }, time: { value: null, confidence: 85 } }));
    expect(facts.date).toBeNull();
    expect(facts.dateConfidence).toBe(0);
    expect(facts.time).toBeNull();
    expect(facts.timeConfidence).toBe(0);
  });

  it("no extracted_json at all (null, empty, malformed) -> every field null/0, never an exception", () => {
    for (const input of [null, undefined, "", "{not json", "null"]) {
      const facts = extractReceiptFacts(input as any);
      expect(facts).toEqual({ date: null, dateConfidence: 0, time: null, timeConfidence: 0, retailerName: null, requestNumber: null });
    }
  });

  it("an object (not a JSON string) is accepted the same way", () => {
    const facts = extractReceiptFacts(JSON.parse(payload()));
    expect(facts.date).toBe("2026-07-12");
    expect(facts.requestNumber).toBe("2301");
  });

  it("falls back to top-level transaction_date/transaction_time when date.value/time.value are absent", () => {
    const facts = extractReceiptFacts(
      JSON.stringify({ transaction_date: "2026-01-05", transaction_date_confidence: 0.8, transaction_time: "09:00:00", transaction_time_confidence: 0.75 })
    );
    expect(facts).toMatchObject({ date: "2026-01-05", dateConfidence: 80, time: "09:00", timeConfidence: 75 });
  });
});

describe("normalizeDate — YYYY-MM-DD or null, never corrected", () => {
  it.each([
    ["2026-07-12", "2026-07-12"],
    ["2026-07-12T00:00:00.000Z", "2026-07-12"], // tolerates a trailing time/offset component
    ["  2026-07-12  ", "2026-07-12"],
    ["", null],
    [null, null],
    [undefined, null],
    ["12/07/2026", "12/07/2026"], // not ISO -> returned as-is (not reformatted/guessed), so it will simply never equal an ISO value
  ])("normalizeDate(%j) -> %j", (input, expected) => {
    expect(normalizeDate(input as any)).toBe(expected);
  });
});

describe("normalizeTime — HH:MM (minute precision) or null, never corrected", () => {
  it.each([
    ["17:55:43", "17:55"],
    ["17:55", "17:55"],
    ["7:05", "07:05"],
    ["", null],
    [null, null],
    [undefined, null],
    ["not a time", null],
  ])("normalizeTime(%j) -> %j", (input, expected) => {
    expect(normalizeTime(input as any)).toBe(expected);
  });
});
