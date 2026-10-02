/**
 * ConsumablesGuard
 *
 * Rejects a completing close when the technician's inventory (moving + fixed,
 * sealed boxes counted at unitsPerBox) cannot cover the consumables entered on
 * it. Runs before any write; the actual deduction happens later in
 * InventoryEngine, which re-checks under row locks.
 */

import { GuardValidationError, isCompletedStatus, type GuardContext, type TechUser } from "./guard.types";
import { bucketUnits, consumableRequirements, resolveConsumableQuantities, type ConsumableSource, type StockBucket } from "../inventory/consumables";

export type ConsumableBalances = Record<string, { unitsPerBox: number; buckets: StockBucket[] }>;

export class ConsumablesGuard {
  static async validate(ctx: GuardContext, techUser: TechUser): Promise<void> {
    const { executionData, existingExecution } = ctx;
    if (!isCompletedStatus(executionData.installationStatus)) {
      return;
    }

    // The same rule the close transaction deducts by (resolveConsumableQuantities);
    // an invalid quantity is rejected here with 422, before anything is written.
    const required = consumableRequirements(
      resolveConsumableQuantities(executionData as ConsumableSource, (existingExecution as ConsumableSource | null) ?? null)
    );
    if (required.length === 0) {
      return;
    }

    // Deduction runs once per request; once done, an edit must not be re-checked
    // against a balance that already reflects it.
    if (await ctx.inventoryPort.hasInventoryDeductionCompletion(ctx.requestId)) {
      return;
    }

    const balances: ConsumableBalances = await ctx.inventoryPort.getTechnicianConsumableBalances(
      techUser.id,
      required.map((r) => r.itemTypeId),
    );

    const shortages = required
      .map((r) => {
        const balance = balances[r.itemTypeId];
        const available = balance
          ? balance.buckets.reduce((sum, b) => sum + bucketUnits(b, balance.unitsPerBox), 0)
          : 0;
        return { ...r, available };
      })
      .filter((r) => r.available < r.quantity);

    if (shortages.length > 0) {
      throw new GuardValidationError(
        `رصيد الفني «${techUser.fullName}» لا يكفي لإغلاق الطلب: ` +
          shortages.map((s) => `${s.label} المطلوب ${s.quantity} والمتاح ${s.available}`).join("، ") +
          ". صحّح الكمية أو أضف الرصيد للفني ثم أعد الإغلاق.",
        "consumables",
      );
    }
  }
}
