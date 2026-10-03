/**
 * SIM type shown on the close form.
 *
 * The SIM type is NOT something the technician chooses: it is the carrier of
 * the SIM's inventory item type, returned by POST /api/courier/serial-lookup as
 * `itemType.carrierName` ("STC" / "Mobily" / "Zain" / "Lebara"). The form only
 * DISPLAYS it, per looked-up SIM; the backend re-derives it from inventory on
 * close and refuses a restated type that disagrees (SIM_TYPE_MISMATCH).
 */

/** The part of a serial-lookup response this derivation reads. */
export interface SimLookupLike {
  found: boolean;
  /** Present only for an exact inventory match (a partial-match fallback has none). */
  item?: unknown;
  itemType?: { carrierName?: string | null } | null;
}

export interface SimRowLike {
  value: string;
  lookup: SimLookupLike | null;
}

export type SimTypeState =
  /** No SIM looked up (yet) — nothing to show. */
  | "EMPTY"
  /** Every looked-up SIM has the same known type. */
  | "KNOWN"
  /** Looked-up SIMs have different known types. */
  | "MIXED"
  /** SIMs were found but their inventory item type names no carrier: never invented. */
  | "UNAVAILABLE";

export interface DerivedSimTypes {
  state: SimTypeState;
  /** Distinct known types, in SIM order. */
  types: string[];
  /** Type of the FIRST SIM (unit 1) — the one the execution row records; null when unknown. */
  primary: string | null;
  /** Text for the read-only field. */
  label: string;
  /** Present when a found SIM has no resolvable type. */
  code?: "SIM_TYPE_UNAVAILABLE";
}

export const SIM_TYPE_UNAVAILABLE_MESSAGE = "نوع الشريحة غير متاح في المخزون (SIM_TYPE_UNAVAILABLE)";

export function deriveSimTypes(rows: SimRowLike[]): DerivedSimTypes {
  const resolved = rows
    .filter((r) => r.value.trim() !== "" && r.lookup?.found === true && !!r.lookup.item)
    .map((r) => {
      const carrier = r.lookup!.itemType?.carrierName?.trim();
      return carrier ? carrier : null;
    });

  if (resolved.length === 0) return { state: "EMPTY", types: [], primary: null, label: "—" };

  const types = [...new Set(resolved.filter((t): t is string => t !== null))];
  const primary = resolved[0];

  if (types.length === 0) {
    return { state: "UNAVAILABLE", types: [], primary: null, label: "غير متاح", code: "SIM_TYPE_UNAVAILABLE" };
  }
  const code = resolved.some((t) => t === null) ? ("SIM_TYPE_UNAVAILABLE" as const) : undefined;
  if (types.length === 1) return { state: "KNOWN", types, primary, label: types[0]!, code };
  return { state: "MIXED", types, primary, label: `متعدد: ${types.join("، ")}`, code };
}
