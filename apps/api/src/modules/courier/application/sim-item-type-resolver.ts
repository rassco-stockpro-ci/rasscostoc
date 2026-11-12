import { itemTypesService as defaultItemTypesService } from "@modules/inventory/contracts/item-types-catalog";
import type { ItemType } from "@shared/schema";

type ActiveItemTypesReader = Pick<typeof defaultItemTypesService, "getActiveItemTypes">;

/**
 * Resolves which catalog SIM item type(s) a scanned serial could belong to,
 * by testing it against each active+visible "sim" category type's serialRegex
 * — never a hardcoded carrier keyword list. Carrier identity is not always
 * derivable from the serial pattern alone (e.g. mobilySim/stcSim/zainSim
 * share an identical pattern in production), so callers must treat a
 * multi-match result as ambiguous and require explicit resolution rather
 * than guessing.
 *
 * `hintText` (the caller's explicit carrier choice) filters the regex-confirmed
 * candidates: it can never introduce a type the serial doesn't match, and a
 * choice that contradicts every match yields zero candidates.
 */
export async function resolveSimItemTypeCandidates(
  serial: string,
  hintText?: string | null,
  itemTypesService: ActiveItemTypesReader = defaultItemTypesService,
): Promise<ItemType[]> {
  const activeTypes = await itemTypesService.getActiveItemTypes();
  // Serialized vs quantity-tracked comes only from the catalog's requiresSerial
  // flag: a requiresSerial=false type is never a candidate for a per-serial item.
  const simTypes = activeTypes.filter(
    (t) => t.category === "sim" && t.requiresSerial === true && !!t.serialRegex,
  );

  const regexMatches = simTypes.filter((t) => {
    try {
      return new RegExp(t.serialRegex as string).test(serial);
    } catch {
      // Malformed regex stored in the catalog — skip it, don't crash the request.
      return false;
    }
  });

  if (!hintText || !hintText.trim()) {
    return regexMatches;
  }

  // An explicit carrier choice must agree with a regex-confirmed candidate: it
  // narrows the set, and a choice that contradicts every regex match yields no
  // candidate at all — the server never overrides the caller's choice with a
  // different type that merely happens to match the pattern.
  const lowerHint = hintText.toLowerCase();
  return regexMatches.filter((t) => {
    const carrierWord = (t.nameEn || "").trim().split(/\s+/)[0]?.toLowerCase();
    return !!carrierWord && lowerHint.includes(carrierWord);
  });
}
