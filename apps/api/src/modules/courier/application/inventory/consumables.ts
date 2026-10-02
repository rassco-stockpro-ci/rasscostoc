/**
 * Consumables delivered to the customer on a courier close, deducted from the
 * technician's inventory. Shared by ConsumablesGuard (pre-close availability
 * check), the close transaction (the actual deduction) and the legacy
 * InventorySubscriber path, so all of them apply one rule.
 */
import { AppError } from "@core/errors/AppError";

export const CONSUMABLE_ITEM_TYPES = {
  paperRollQty: { itemTypeId: "rollPaper", label: "ورق الطباعة (رول)" },
  stickersQty: { itemTypeId: "stickers", label: "الملصقات" },
  nulipCardsQty: { itemTypeId: "1010", label: "بطاقات نيوليب" },
} as const;

export type ConsumableQuantities = {
  paperRollQty?: number | string | null;
  stickersQty?: number | string | null;
  nulipCardsQty?: number | string | null;
};

/** An execution (as submitted, or as stored) seen through its consumable fields. */
export type ConsumableSource = ConsumableQuantities & { paperRoll?: string | null };

export type ResolvedConsumableQuantities = { paperRollQty: number; stickersQty: number; nulipCardsQty: number };

export class ConsumableQuantityError extends AppError {
  constructor(label: string, value: unknown) {
    super(`كمية ${label} غير صالحة: «${String(value)}». أدخل عدداً صحيحاً موجباً أو صفراً.`, 422, true, "CONSUMABLE_QUANTITY_INVALID");
    this.name = "ConsumableQuantityError";
  }
}

/**
 * THE consumable quantity rule of a completed close. One function, used by
 * the guard (on the submitted values over the stored row) and by the
 * deduction (on the saved row), so both always agree.
 *
 * Per field, the effective value is:
 *   - the submitted value when one is submitted (not undefined);
 *   - otherwise the stored value of an existing execution;
 *   - otherwise 0 (the column default of a new row).
 * Then:
 *   - empty (null or "")  : no explicit quantity. Paper rolls fall back to the
 *                           legacy Yes/No flag (paperRoll "Yes" -> 1 roll, as
 *                           rows written before the quantity column did);
 *                           stickers and cards -> 0;
 *   - a non-negative integer (number or digit string) : that quantity;
 *   - anything else (negative, fractional, non-numeric): ConsumableQuantityError (422).
 */
export function resolveConsumableQuantities(
  input: ConsumableSource,
  stored: ConsumableSource | null
): ResolvedConsumableQuantities {
  const pick = <K extends keyof ConsumableSource>(key: K): ConsumableSource[K] =>
    input[key] !== undefined ? input[key] : stored ? stored[key] : undefined;
  const paperRoll = pick("paperRoll");

  const resolve = (key: keyof typeof CONSUMABLE_ITEM_TYPES): number => {
    const raw = pick(key);
    if (raw === undefined) return 0;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      return key === "paperRollQty" && paperRoll === "Yes" ? 1 : 0;
    }
    const n = typeof raw === "number" ? raw : /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 0) {
      throw new ConsumableQuantityError(CONSUMABLE_ITEM_TYPES[key].label, raw);
    }
    return n;
  };

  return {
    paperRollQty: resolve("paperRollQty"),
    stickersQty: resolve("stickersQty"),
    nulipCardsQty: resolve("nulipCardsQty"),
  };
}

export interface ConsumableRequirement {
  itemTypeId: string;
  label: string;
  quantity: number;
}

/** Positive quantities only, sorted by itemTypeId (a stable lock order for the deduction). */
export function consumableRequirements(q: ConsumableQuantities): ConsumableRequirement[] {
  return (Object.keys(CONSUMABLE_ITEM_TYPES) as (keyof typeof CONSUMABLE_ITEM_TYPES)[])
    .map((key) => ({
      ...CONSUMABLE_ITEM_TYPES[key],
      quantity: Math.max(0, Math.trunc(Number(q[key] ?? 0)) || 0),
    }))
    .filter((r) => r.quantity > 0)
    .sort((a, b) => (a.itemTypeId < b.itemTypeId ? -1 : a.itemTypeId > b.itemTypeId ? 1 : 0));
}

export interface StockBucket {
  boxes: number;
  units: number;
}

/** Units available in a bucket: sealed boxes are counted at unitsPerBox each. */
export function bucketUnits(bucket: StockBucket, unitsPerBox: number): number {
  return Math.max(0, bucket.boxes) * unitsPerBox + Math.max(0, bucket.units);
}
