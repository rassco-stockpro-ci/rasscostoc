/**
 * Pure rules of installation units (no database, no I/O): structure,
 * duplicates, limits, resolved-item uniqueness.
 */
import { describe, expect, it } from "vitest";
import {
  CloseUnitError,
  MAX_CLOSE_UNITS,
  assertResolvedUnits,
  assertSimTypes,
  assertUnitStructure,
  normalizeCarrier,
  primarySimType,
  serialKey,
  type CloseUnitSpec,
  type ResolvedCloseUnit,
} from "./execution-unit";

const u = (no: number, device: string, sim: string | null, waived = false): CloseUnitSpec => ({
  unitNo: no, deviceSerial: device, simSerial: sim, simWaived: waived, tid: null,
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CloseUnitError);
    expect((e as CloseUnitError).statusCode).toBe(422);
    return (e as CloseUnitError).unitCode;
  }
  return null;
};

describe("assertUnitStructure", () => {
  it("accepts 1..MAX units of device+SIM and a declared device-only unit", () => {
    expect(code(() => assertUnitStructure([u(1, "A1", "S1")]))).toBeNull();
    expect(code(() => assertUnitStructure([u(1, "A1", "S1"), u(2, "A2", null, true)]))).toBeNull();
    const many = Array.from({ length: MAX_CLOSE_UNITS }, (_, i) => u(i + 1, `D${i}`, `S${i}`));
    expect(code(() => assertUnitStructure(many))).toBeNull();
  });

  it("refuses the documented invalid shapes with their stable codes", () => {
    expect(code(() => assertUnitStructure([]))).toBe("UNIT_DEVICE_REQUIRED");
    expect(code(() => assertUnitStructure([u(1, "", null)]))).toBe("UNIT_DEVICE_REQUIRED");
    expect(code(() => assertUnitStructure([u(1, "", "S1")]))).toBe("UNIT_SIM_WITHOUT_DEVICE");
    expect(code(() => assertUnitStructure([u(1, "A1", null)]))).toBe("UNIT_SIM_MISSING_NOT_WAIVED");
    expect(code(() => assertUnitStructure([u(1, "A1", "S1", true)]))).toBe("UNIT_SIM_WAIVER_CONFLICT");
    expect(code(() => assertUnitStructure([u(1, "A1", "S1"), u(2, "A1", "S2")]))).toBe("UNIT_DUPLICATE_DEVICE");
    expect(code(() => assertUnitStructure([u(1, "A1", "S1"), u(2, "A2", "S1")]))).toBe("UNIT_DUPLICATE_SIM");
    const tooMany = Array.from({ length: MAX_CLOSE_UNITS + 1 }, (_, i) => u(i + 1, `D${i}`, `S${i}`));
    expect(code(() => assertUnitStructure(tooMany))).toBe("UNIT_LIMIT_EXCEEDED");
  });

  it("serials are compared the way the central engine does (case, dashes, spaces, dots)", () => {
    expect(serialKey(" nc-d.700 022_155 ")).toBe(serialKey("NCD700022155"));
    expect(code(() => assertUnitStructure([u(1, "NCD700022155", "S1"), u(2, "ncd-700022155", "S2")]))).toBe("UNIT_DUPLICATE_DEVICE");
    // a serial used as a device in one unit and as a SIM in another is also a duplicate
    expect(code(() => assertUnitStructure([u(1, "X1", "S1"), u(2, "S1", "S2")]))).toBe("UNIT_DUPLICATE_DEVICE");
  });
});

describe("assertResolvedUnits — one physical item once, whatever its spelling", () => {
  const r = (no: number, dev: string, sim: string | null): ResolvedCloseUnit => ({
    unitNo: no, device: { itemId: dev, serialNumber: dev }, sim: sim ? { itemId: sim, serialNumber: sim } : null, simWaived: !sim, tid: null,
  });
  it("accepts distinct items and refuses a repeated device or SIM item", () => {
    expect(code(() => assertResolvedUnits([r(1, "d1", "s1"), r(2, "d2", "s2")]))).toBeNull();
    expect(code(() => assertResolvedUnits([r(1, "d1", "s1"), r(2, "d1", "s2")]))).toBe("UNIT_DUPLICATE_DEVICE");
    expect(code(() => assertResolvedUnits([r(1, "d1", "s1"), r(2, "d2", "s1")]))).toBe("UNIT_DUPLICATE_SIM");
  });
});

describe("SIM type: inventory is the source of truth", () => {
  const unit = (no: number, carrier: string | null | "NO_SIM"): ResolvedCloseUnit => ({
    unitNo: no,
    device: { itemId: `d${no}`, serialNumber: `D${no}` },
    sim: carrier === "NO_SIM" ? null : { itemId: `s${no}`, serialNumber: `S${no}`, carrierName: carrier },
    simWaived: carrier === "NO_SIM",
    tid: null,
  });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof CloseUnitError ? e.unitCode : "OTHER";
    }
    return null;
  };

  it("a restated type that matches inventory (any case) passes", () => {
    expect(code(() => assertSimTypes([unit(1, "STC")], { perUnit: ["stc"], scalar: " STC " }))).toBeNull();
    expect(normalizeCarrier(" zain ")).toBe("ZAIN");
  });

  it("a type that disagrees with the unit's SIM is refused, per unit", () => {
    expect(code(() => assertSimTypes([unit(1, "STC")], { perUnit: ["Zain"] }))).toBe("SIM_TYPE_MISMATCH");
    expect(code(() => assertSimTypes([unit(1, "STC"), unit(2, "Zain")], { perUnit: ["STC", "STC"] }))).toBe("SIM_TYPE_MISMATCH");
    expect(code(() => assertSimTypes([unit(1, "STC"), unit(2, "Zain")], { perUnit: ["STC", "Zain"] }))).toBeNull();
  });

  it("a type claimed for a unit without a SIM is refused", () => {
    expect(code(() => assertSimTypes([unit(1, "NO_SIM")], { perUnit: ["STC"] }))).toBe("SIM_TYPE_MISMATCH");
    expect(code(() => assertSimTypes([unit(1, "NO_SIM")], { perUnit: [null] }))).toBeNull();
  });

  it("the legacy scalar must name the type of at least one SIM in the close", () => {
    expect(code(() => assertSimTypes([unit(1, "STC"), unit(2, "Zain")], { perUnit: [], scalar: "Zain" }))).toBeNull();
    expect(code(() => assertSimTypes([unit(1, "STC"), unit(2, "Zain")], { perUnit: [], scalar: "Mobily" }))).toBe("SIM_TYPE_MISMATCH");
  });

  it("an unnamed inventory type cannot be checked: the claim is ignored (and never stored), not refused", () => {
    expect(code(() => assertSimTypes([unit(1, null)], { perUnit: ["STC"], scalar: "STC" }))).toBeNull();
    expect(primarySimType([unit(1, null)])).toBeNull();
  });

  it("the execution row's type is unit 1's SIM type", () => {
    expect(primarySimType([unit(1, "Zain"), unit(2, "STC")])).toBe("Zain");
    expect(primarySimType([unit(1, "NO_SIM"), unit(2, "STC")])).toBeNull();
    expect(primarySimType([])).toBeNull();
  });
});
