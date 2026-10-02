/**
 * Every way a client describes what a close installed, turned into one
 * CloseUnitsPlan (domain/execution-unit.ts):
 *
 *   1. units[]            the contract; authoritative when present (EXPLICIT)
 *   2. legacy lists       sn / simSerial / deviceSerials[] / simSerials[]
 *                         (+ serial-like legacy extra fields as devices):
 *                         one device + one SIM is unambiguous (EXPLICIT);
 *                         anything else is paired by order and flagged
 *                         LEGACY_INFERRED, or refused with PAIRING_REQUIRED
 *                         once the transition period is closed
 *   3. PDF devices[]      the AI-extracted cards the Telegram bot submits
 *                         ({ sn, sim_serial, tid, sim_waived? }): EXPLICIT
 */
import {
  CloseUnitError,
  assertUnitStructure,
  type CloseUnitSpec,
  type CloseUnitsPlan,
} from "../../domain/execution-unit";

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** The units[] contract. */
export function unitsFromPayload(raw: unknown): CloseUnitsPlan {
  if (!Array.isArray(raw)) {
    throw new CloseUnitError("UNIT_INVALID_PAYLOAD", "الحقل units يجب أن يكون قائمة.");
  }
  const units: CloseUnitSpec[] = raw.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new CloseUnitError("UNIT_INVALID_PAYLOAD", `الوحدة ${i + 1} غير صالحة.`, i + 1);
    }
    const u = entry as Record<string, unknown>;
    return {
      unitNo: i + 1,
      deviceSerial: text(u.deviceSerial),
      simSerial: text(u.simSerial) || null,
      simWaived: u.simWaived === true,
      tid: text(u.tid) || null,
    };
  });
  assertUnitStructure(units);
  return { units, pairingSource: "EXPLICIT" };
}

/**
 * Legacy unpaired lists. Returns null when nothing was submitted (the
 * structural guard reports a missing device for a completed close).
 */
export function unitsFromLegacyLists(
  devices: string[],
  sims: string[],
  opts: { requireExplicitPairing: boolean }
): CloseUnitsPlan | null {
  if (devices.length === 0 && sims.length === 0) return null;
  if (sims.length > devices.length) {
    throw new CloseUnitError("UNIT_SIM_WITHOUT_DEVICE", "عدد الشرائح أكبر من عدد الأجهزة: شريحة بدون جهاز غير مسموح.");
  }
  const unambiguous = devices.length === 1 && sims.length === 1;
  if (!unambiguous && opts.requireExplicitPairing) {
    throw new CloseUnitError(
      "PAIRING_REQUIRED",
      "أرسل الأجهزة والشرائح كوحدات مقترنة (units) — قوائم الأجهزة والشرائح غير المقترنة لم تعد مقبولة."
    );
  }
  const units: CloseUnitSpec[] = devices.map((deviceSerial, i) => ({
    unitNo: i + 1,
    deviceSerial,
    simSerial: sims[i] ?? null,
    // A legacy device listed without a SIM: the old contract allowed it, so
    // the waiver is inferred (and the whole plan flagged LEGACY_INFERRED).
    simWaived: sims[i] == null,
    tid: null,
  }));
  assertUnitStructure(units);
  return { units, pairingSource: unambiguous ? "EXPLICIT" : "LEGACY_INFERRED" };
}

/** PDF approval devices[] (Telegram bot / AI extraction): explicit pairs. */
export function unitsFromPdfDevices(
  devices: Array<{ sn?: string | null; sim_serial?: string | null; tid?: string | null; sim_waived?: boolean | null }>
): CloseUnitsPlan {
  const entries = devices.filter((d) => text(d.sn) || text(d.sim_serial));
  const units: CloseUnitSpec[] = entries.map((d, i) => ({
    unitNo: i + 1,
    deviceSerial: text(d.sn),
    simSerial: text(d.sim_serial) || null,
    simWaived: d.sim_waived === true,
    tid: text(d.tid) || null,
  }));
  assertUnitStructure(units);
  return { units, pairingSource: "EXPLICIT" };
}

/** The serial lists the existing guards read (sn / deviceSerials / simSerials). */
export function serialListsOf(plan: CloseUnitsPlan): { deviceSerials: string[]; simSerials: string[] } {
  return {
    deviceSerials: plan.units.map((u) => u.deviceSerial),
    simSerials: plan.units.filter((u) => u.simSerial).map((u) => u.simSerial as string),
  };
}

/**
 * End of the transition period for unpaired lists (COURIER_REQUIRE_EXPLICIT_PAIRING=true).
 * Read at call time so the switch needs no redeploy of code, only of config.
 */
export function explicitPairingRequired(): boolean {
  return process.env.COURIER_REQUIRE_EXPLICIT_PAIRING === "true";
}
