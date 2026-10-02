/**
 * Installation unit of a courier close ("execution unit").
 *
 * A close installs N units. Each unit is one terminal: exactly one device,
 * at most one SIM, an optional TID. The unit is the Device<->SIM pairing; it
 * is persisted in courier_execution_units inside the close transaction.
 *
 * The SIM type of a unit is NOT a free input: it is the carrier of the SIM's
 * inventory item type (item_types), resolved by the custody guard. A client may
 * restate it (units[].simType, legacy simType); a restatement that disagrees with
 * the inventory is refused (SIM_TYPE_MISMATCH).
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
  /** The SIM type the client claims for this unit (never trusted, only compared). */
  simType?: string | null;
}

export interface CloseUnitsPlan {
  units: CloseUnitSpec[];
  pairingSource: PairingSource;
}

/** A unit whose serials resolved to inventory items in the technician's active custody. */
export interface ResolvedCloseUnit {
  unitNo: number;
  device: { itemId: string; serialNumber: string };
  /** carrierName: the SIM's type from inventory (STC / Mobily / Zain / Lebara), null when its item type names none. */
  sim: { itemId: string; serialNumber: string; carrierName: string | null } | null;
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
  | "SIM_TYPE_MISMATCH"
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

/** Comparison form of a SIM type / carrier name. */
export function normalizeCarrier(value: string): string {
  return value.trim().toUpperCase();
}

/** The SIM type the execution row (sn / sim_serial / sim_type) records: unit 1's SIM, from inventory. */
export function primarySimType(units: ResolvedCloseUnit[]): string | null {
  return units[0]?.sim?.carrierName ?? null;
}

/**
 * A client may restate SIM types; inventory is the source of truth.
 *   - per unit (units[].simType): must equal that unit's SIM type; a type claimed
 *     for a unit with no SIM is refused;
 *   - scalar (legacy simType): must equal the type of at least one SIM of the close.
 * A claim that cannot be checked because the inventory names no carrier for the
 * SIM is ignored — it is never stored (SIM_TYPE_UNAVAILABLE stays visible in the
 * read model as simType: null).
 */
export function assertSimTypes(
  units: ResolvedCloseUnit[],
  claims: { perUnit: Array<string | null | undefined>; scalar?: string | null }
): void {
  units.forEach((unit, i) => {
    const claimed = claims.perUnit[i]?.trim();
    if (!claimed) return;
    if (!unit.sim) {
      throw new CloseUnitError("SIM_TYPE_MISMATCH", `الوحدة ${unit.unitNo}: لا توجد شريحة لتحديد نوعها (${claimed}).`, unit.unitNo);
    }
    const actual = unit.sim.carrierName;
    if (actual && normalizeCarrier(actual) !== normalizeCarrier(claimed)) {
      throw new CloseUnitError(
        "SIM_TYPE_MISMATCH",
        `الوحدة ${unit.unitNo}: نوع الشريحة المرسل (${claimed}) لا يطابق نوعها في المخزون (${actual}).`,
        unit.unitNo
      );
    }
  });

  const scalar = claims.scalar?.trim();
  if (scalar) {
    const known = units.flatMap((u) => (u.sim?.carrierName ? [normalizeCarrier(u.sim.carrierName)] : []));
    if (known.length > 0 && !known.includes(normalizeCarrier(scalar))) {
      throw new CloseUnitError(
        "SIM_TYPE_MISMATCH",
        `نوع الشريحة المرسل (${scalar}) لا يطابق نوع أي شريحة في الإغلاق (${[...new Set(known)].join("، ")}).`
      );
    }
  }
}

/** Item categories (item_types.category) a unit role accepts. */
export const ROLE_CATEGORY: Record<"device" | "sim", string> = { device: "devices", sim: "sim" };
