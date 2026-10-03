/**
 * Every way a client describes the units of a close — units[], the legacy
 * lists, and the bot's PDF device cards — becomes one plan (no database).
 */
import { afterEach, describe, expect, it } from "vitest";
import { CloseUnitError } from "../../domain/execution-unit";
import {
  explicitPairingRequired,
  serialListsOf,
  unitsFromLegacyLists,
  unitsFromPayload,
  unitsFromPdfDevices,
} from "./close-units";

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

describe("units[] contract", () => {
  it("builds numbered EXPLICIT units with TID and waiver", () => {
    const plan = unitsFromPayload([{ deviceSerial: " A1 ", simSerial: "S1", tid: "T1" }, { deviceSerial: "A2", simWaived: true }]);
    expect(plan.pairingSource).toBe("EXPLICIT");
    expect(plan.units).toEqual([
      { unitNo: 1, deviceSerial: "A1", simSerial: "S1", simWaived: false, tid: "T1", simType: null },
      { unitNo: 2, deviceSerial: "A2", simSerial: null, simWaived: true, tid: null, simType: null },
    ]);
    expect(serialListsOf(plan)).toEqual({ deviceSerials: ["A1", "A2"], simSerials: ["S1"] });
  });
  it("a restated simType is carried only to be compared with inventory", () => {
    const plan = unitsFromPayload([{ deviceSerial: "A1", simSerial: "S1", simType: " STC " }]);
    expect(plan.units[0]!.simType).toBe("STC");
  });
  it("refuses a non-list or malformed entries", () => {
    expect(code(() => unitsFromPayload("A1"))).toBe("UNIT_INVALID_PAYLOAD");
    expect(code(() => unitsFromPayload([null]))).toBe("UNIT_INVALID_PAYLOAD");
    expect(code(() => unitsFromPayload([]))).toBe("UNIT_DEVICE_REQUIRED");
  });
});

describe("legacy lists", () => {
  afterEach(() => delete process.env.COURIER_REQUIRE_EXPLICIT_PAIRING);

  it("nothing submitted → no plan (the structural guard reports the missing device)", () => {
    expect(unitsFromLegacyLists([], [], { requireExplicitPairing: false })).toBeNull();
  });
  it("one device + one SIM is unambiguous: EXPLICIT", () => {
    expect(unitsFromLegacyLists(["A1"], ["S1"], { requireExplicitPairing: true })?.pairingSource).toBe("EXPLICIT");
  });
  it("several devices/SIMs are paired by order and flagged LEGACY_INFERRED; extra devices become waived units", () => {
    const plan = unitsFromLegacyLists(["A1", "A2", "A3"], ["S1", "S2"], { requireExplicitPairing: false })!;
    expect(plan.pairingSource).toBe("LEGACY_INFERRED");
    expect(plan.units.map((x) => [x.deviceSerial, x.simSerial, x.simWaived])).toEqual([
      ["A1", "S1", false], ["A2", "S2", false], ["A3", null, true],
    ]);
  });
  it("more SIMs than devices → UNIT_SIM_WITHOUT_DEVICE", () => {
    expect(code(() => unitsFromLegacyLists(["A1"], ["S1", "S2"], { requireExplicitPairing: false }))).toBe("UNIT_SIM_WITHOUT_DEVICE");
  });
  it("transition closed: ambiguous lists → PAIRING_REQUIRED; the unambiguous pair still closes", () => {
    expect(code(() => unitsFromLegacyLists(["A1", "A2"], ["S1", "S2"], { requireExplicitPairing: true }))).toBe("PAIRING_REQUIRED");
    expect(code(() => unitsFromLegacyLists(["A1", "A2"], [], { requireExplicitPairing: true }))).toBe("PAIRING_REQUIRED");
    expect(code(() => unitsFromLegacyLists(["A1"], ["S1"], { requireExplicitPairing: true }))).toBeNull();
  });
  it("the transition switch is read from COURIER_REQUIRE_EXPLICIT_PAIRING at call time", () => {
    expect(explicitPairingRequired()).toBe(false);
    process.env.COURIER_REQUIRE_EXPLICIT_PAIRING = "true";
    expect(explicitPairingRequired()).toBe(true);
  });
});

describe("PDF devices[] (the Telegram bot's cards)", () => {
  it("each card is an explicit unit; cards with neither serial are ignored; sim_waived is honoured", () => {
    const plan = unitsFromPdfDevices([
      { sn: "A1", sim_serial: "S1", tid: "T1" },
      { sn: null, sim_serial: null },
      { sn: "A2", sim_serial: null, sim_waived: true, tid: "T2" },
    ]);
    expect(plan.pairingSource).toBe("EXPLICIT");
    expect(plan.units.map((x) => [x.unitNo, x.deviceSerial, x.simSerial, x.simWaived, x.tid])).toEqual([
      [1, "A1", "S1", false, "T1"], [2, "A2", null, true, "T2"],
    ]);
  });
  it("a card with a SIM and no device, or a device without SIM and without the declaration, is refused", () => {
    expect(code(() => unitsFromPdfDevices([{ sn: null, sim_serial: "S1" }]))).toBe("UNIT_SIM_WITHOUT_DEVICE");
    expect(code(() => unitsFromPdfDevices([{ sn: "A1", sim_serial: null }]))).toBe("UNIT_SIM_MISSING_NOT_WAIVED");
  });
});
