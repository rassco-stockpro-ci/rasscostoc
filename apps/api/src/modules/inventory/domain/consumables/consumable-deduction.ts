/**
 * Pure allocation for deducting a consumable quantity (in units) across a
 * technician's stock rows, in the order given (moving rows before fixed).
 * Loose units are used first; sealed boxes are opened only when needed and the
 * remainder of an opened box returns to loose units.
 */

export interface StockBucket {
  boxes: number;
  units: number;
}

export type ConsumableDeductionPlan =
  | { ok: true; after: StockBucket[]; taken: number[] }
  | { ok: false; available: number };

export function bucketUnits(bucket: StockBucket, unitsPerBox: number): number {
  return Math.max(0, bucket.boxes) * unitsPerBox + Math.max(0, bucket.units);
}

function takeUnits(bucket: StockBucket, quantity: number, unitsPerBox: number): StockBucket {
  const boxes = Math.max(0, bucket.boxes);
  const units = Math.max(0, bucket.units);
  if (quantity <= units) {
    return { boxes, units: units - quantity };
  }
  const boxesToOpen = Math.ceil((quantity - units) / unitsPerBox);
  return { boxes: boxes - boxesToOpen, units: units + boxesToOpen * unitsPerBox - quantity };
}

export function planConsumableDeduction(
  quantity: number,
  unitsPerBox: number,
  buckets: StockBucket[],
): ConsumableDeductionPlan {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Invalid consumable quantity: ${quantity}`);
  }
  if (!Number.isInteger(unitsPerBox) || unitsPerBox <= 0) {
    throw new Error(`Invalid unitsPerBox: ${unitsPerBox}`);
  }
  const available = buckets.reduce((sum, b) => sum + bucketUnits(b, unitsPerBox), 0);
  if (quantity > available) {
    return { ok: false, available };
  }
  let remaining = quantity;
  const after: StockBucket[] = [];
  const taken: number[] = [];
  for (const bucket of buckets) {
    const take = Math.min(remaining, bucketUnits(bucket, unitsPerBox));
    after.push(take > 0 ? takeUnits(bucket, take, unitsPerBox) : { ...bucket });
    taken.push(take);
    remaining -= take;
  }
  return { ok: true, after, taken };
}
