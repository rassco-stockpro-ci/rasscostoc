/**
 * Installation unit of a courier close ("execution unit").
 *
 * A close installs N units. Each unit is one terminal: exactly one device,
 * at most one SIM, an optional TID. The unit is the Device<->SIM pairing; it
 * is persisted in courier_execution_units inside the close transaction.
 *
 * Domain decisions (product owner, 2026-10-02):
 *   - a device without a SIM is allowed only when declared (simWaived);
 *   - a SIM without a device is not allowed;
 *   - the unit count differing from the request's expected count is a
 *     warning, never a rejection;
 *   - unpaired legacy lists are paired by order and flagged LEGACY_INFERRED
 *     during the transition period, then refused with PAIRING_REQUIRED.
 */
import { AppError } from "@core/errors/AppError";

/** Upper bound of units per close (bounds the transaction's row locks). */
export const MAX_CLOSE_UNITS = 20;

export type PairingSource = "EXPLICIT" | "LEGACY_INFERRED";

/** A unit as submitted: serials not yet resolved against inventory. */
export interface CloseUnitSpec {
  unitNo: number;
  deviceSerial: string;
  simSerial: string | null;
  simWaived: boolean;
  tid: string | null;
}

export interface CloseUnitsPlan {
  units: CloseUnitSpec[];
  pairingSource: PairingSource;
}

/** A unit whose serials resolved to inventory items in the technician's active custody. */
export interface ResolvedCloseUnit {
  unitNo: number;
  device: { itemId: string; serialNumber: string };
  sim: { itemId: string; serialNumber: string } | null;
  simWaived: boolean;
  tid: string | null;
}

export type CloseUnitErrorCode =
  | "UNIT_DEVICE_REQUIRED"
  | "UNIT_SIM_WITHOUT_DEVICE"
  | "UNIT_SIM_MISSING_NOT_WAIVED"
  | "UNIT_SIM_WAIVER_CONFLICT"
  | "UNIT_DUPLICATE_DEVICE"
  | "UNIT_DUPLICATE_SIM"
  | "UNIT_ROLE_MISMATCH"
  | "UNIT_LIMIT_EXCEEDED"
  | "UNIT_INVALID_PAYLOAD"
  | "PAIRING_REQUIRED";

export class CloseUnitError extends AppError {
  constructor(
    readonly unitCode: CloseUnitErrorCode,
    message: string,
    readonly unitNo?: number
  ) {
    super(message, 422, true, unitCode);
    this.name = "CloseUnitError";
  }
}

/** Comparison key for "the same serial" before inventory resolution. */
export function serialKey(serial: string): string {
  return serial.trim().toUpperCase().replace(/[\s\-_.]/g, "");
}

/**
 * Structural invariants of a set of units, before any inventory lookup.
 * Item-level checks (custody, category, same item under two spellings) run
 * after resolution (assertResolvedUnits).
 */
export function assertUnitStructure(units: CloseUnitSpec[]): void {
  if (units.length === 0) {
    throw new CloseUnitError("UNIT_DEVICE_REQUIRED", "يجب إدخال جهاز واحد على الأقل لإغلاق الطلب.");
  }
  if (units.length > MAX_CLOSE_UNITS) {
    throw new CloseUnitError("UNIT_LIMIT_EXCEEDED", `الحد الأعلى ${MAX_CLOSE_UNITS} جهازًا في الإغلاق الواحد (المرسل ${units.length}).`);
  }
  const devices = new Set<string>();
  const sims = new Set<string>();
  for (const u of units) {
    if (!u.deviceSerial) {
      throw u.simSerial
        ? new CloseUnitError("UNIT_SIM_WITHOUT_DEVICE", `الوحدة ${u.unitNo}: شريحة بدون جهاز غير مسموح.`, u.unitNo)
        : new CloseUnitError("UNIT_DEVICE_REQUIRED", `الوحدة ${u.unitNo}: رقم الجهاز مطلوب.`, u.unitNo);
    }
    if (u.simSerial && u.simWaived) {
      throw new CloseUnitError("UNIT_SIM_WAIVER_CONFLICT", `الوحدة ${u.unitNo}: لا يجتمع رقم شريحة مع التصريح بعدم وجودها.`, u.unitNo);
    }
    if (!u.simSerial && !u.simWaived) {
      throw new CloseUnitError(
        "UNIT_SIM_MISSING_NOT_WAIVED",
        `الوحدة ${u.unitNo}: الجهاز ${u.deviceSerial} بدون شريحة. أدخل الشريحة أو صرّح بعدم وجودها.`,
        u.unitNo
      );
    }
    const dk = serialKey(u.deviceSerial);
    if (devices.has(dk) || sims.has(dk)) {
      throw new CloseUnitError("UNIT_DUPLICATE_DEVICE", `الجهاز ${u.deviceSerial} مكرر في الإغلاق.`, u.unitNo);
    }
    devices.add(dk);
    if (u.simSerial) {
      const sk = serialKey(u.simSerial);
      if (sims.has(sk) || devices.has(sk)) {
        throw new CloseUnitError("UNIT_DUPLICATE_SIM", `الشريحة ${u.simSerial} مكررة في الإغلاق.`, u.unitNo);
      }
      sims.add(sk);
    }
  }
}

/** The same physical item may not appear twice (two spellings of one serial). */
export function assertResolvedUnits(units: ResolvedCloseUnit[]): void {
  const seen = new Map<string, "device" | "sim">();
  for (const u of units) {
    if (seen.has(u.device.itemId)) {
      throw new CloseUnitError("UNIT_DUPLICATE_DEVICE", `الجهاز ${u.device.serialNumber} مكرر في الإغلاق.`, u.unitNo);
    }
    seen.set(u.device.itemId, "device");
    if (u.sim) {
      if (seen.has(u.sim.itemId)) {
        throw new CloseUnitError("UNIT_DUPLICATE_SIM", `الشريحة ${u.sim.serialNumber} مكررة في الإغلاق.`, u.unitNo);
      }
      seen.set(u.sim.itemId, "sim");
    }
  }
}

/** Item categories (item_types.category) a unit role accepts. */
export const ROLE_CATEGORY: Record<"device" | "sim", string> = { device: "devices", sim: "sim" };
