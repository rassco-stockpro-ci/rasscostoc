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
 * `hintText` (e.g. free-text carrier name from the request) is used only to
 * narrow an already regex-ambiguous candidate set down to one — never as the
 * primary source of truth on its own.
 */
export async function resolveSimItemTypeCandidates(
  serial: string,
  hintText?: string | null,
  itemTypesService: ActiveItemTypesReader = defaultItemTypesService,
): Promise<ItemType[]> {
  const activeTypes = await itemTypesService.getActiveItemTypes();
  const simTypes = activeTypes.filter(
    (t) => t.category === "sim" && !!t.serialRegex,
  );

  const regexMatches = simTypes.filter((t) => {
    try {
      return new RegExp(t.serialRegex as string).test(serial);
    } catch {
      // Malformed regex stored in the catalog — skip it, don't crash the request.
      return false;
    }
  });

  if (regexMatches.length <= 1 || !hintText) {
    return regexMatches;
  }

  const lowerHint = hintText.toLowerCase();
  const narrowed = regexMatches.filter((t) => {
    const carrierWord = (t.nameEn || "").trim().split(/\s+/)[0]?.toLowerCase();
    return !!carrierWord && lowerHint.includes(carrierWord);
  });

  return narrowed.length === 1 ? narrowed : regexMatches;
}
