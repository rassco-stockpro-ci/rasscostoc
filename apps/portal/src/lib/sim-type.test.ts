import { describe, expect, it } from "vitest";
import { deriveSimTypes, type SimRowLike } from "./sim-type";

/** What POST /api/courier/serial-lookup returns for an exact inventory match. */
const found = (carrierName: string | null): SimRowLike["lookup"] => ({
  found: true,
  item: { id: "x", serialNumber: "s", status: "RECEIVED_BY_TECHNICIAN" },
  itemType: { carrierName },
});
const row = (value: string, lookup: SimRowLike["lookup"]): SimRowLike => ({ value, lookup });

describe("deriveSimTypes — the SIM type comes from the serial lookup, never from the user", () => {
  it("1 SIM, known type → shown and sent as the primary type", () => {
    const d = deriveSimTypes([row("8996601", found("STC"))]);
    expect(d).toMatchObject({ state: "KNOWN", types: ["STC"], primary: "STC", label: "STC" });
    expect(d.code).toBeUndefined();
  });

  it("known SIM whose inventory type names no carrier → UNAVAILABLE: nothing is invented, nothing is sent", () => {
    const d = deriveSimTypes([row("8996601", found(null))]);
    expect(d).toMatchObject({ state: "UNAVAILABLE", types: [], primary: null, code: "SIM_TYPE_UNAVAILABLE" });
    expect(d.label).toBe("غير متاح");
  });

  it("serial not found → no type", () => {
    expect(deriveSimTypes([row("8996601", { found: false })]).state).toBe("EMPTY");
  });

  it("lookup not done yet / cleared after the ICCID changed → no stale type", () => {
    expect(deriveSimTypes([row("8996601", null)])).toMatchObject({ state: "EMPTY", primary: null });
    // the same row after editing the serial: lookup reset to null
    const before = deriveSimTypes([row("8996601", found("STC"))]);
    const after = deriveSimTypes([row("8996602", null)]);
    expect(before.primary).toBe("STC");
    expect(after).toMatchObject({ state: "EMPTY", primary: null, label: "—" });
  });

  it("a partial-match fallback (found, but no exact item) never supplies a type", () => {
    const d = deriveSimTypes([row("8996601", { found: true, itemType: { carrierName: "STC" } })]);
    expect(d.state).toBe("EMPTY");
    expect(d.primary).toBeNull();
  });

  it("empty rows are ignored", () => {
    expect(deriveSimTypes([row("", found("STC")), row("  ", found("Zain"))]).state).toBe("EMPTY");
  });

  it("2 SIMs of different types: each keeps its own type; the primary is the FIRST SIM's", () => {
    const d = deriveSimTypes([row("A", found("STC")), row("B", found("Zain"))]);
    expect(d).toMatchObject({ state: "MIXED", types: ["STC", "Zain"], primary: "STC", label: "متعدد: STC، Zain" });
    const reversed = deriveSimTypes([row("B", found("Zain")), row("A", found("STC"))]);
    expect(reversed.primary).toBe("Zain");
  });

  it("2 SIMs of the same type collapse to one label", () => {
    expect(deriveSimTypes([row("A", found("STC")), row("B", found("STC"))])).toMatchObject({ state: "KNOWN", types: ["STC"] });
  });

  it("one SIM known and one unnamed → the known type is shown, the gap is flagged, the primary stays unit 1's", () => {
    const d = deriveSimTypes([row("A", found("STC")), row("B", found(null))]);
    expect(d).toMatchObject({ state: "KNOWN", types: ["STC"], primary: "STC", code: "SIM_TYPE_UNAVAILABLE" });
    // when the FIRST SIM is the unnamed one, nothing is sent as the execution's type
    expect(deriveSimTypes([row("B", found(null)), row("A", found("STC"))]).primary).toBeNull();
  });
});
