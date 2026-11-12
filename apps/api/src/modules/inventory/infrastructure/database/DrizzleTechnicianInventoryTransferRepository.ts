import { and, eq } from 'drizzle-orm';
import {
  technicianFixedInventories,
  technicianFixedInventoryEntries,
  technicianMovingInventoryEntries,
} from "@shared/schema";
import type {
  TechnicianInventoryBalance,
  TransferInventoryType,
} from "@modules/inventory/application/inventory/contracts/ITechnicianInventoryTransferRepository";
import type { TechnicianFixedInventory } from '@shared/schema';
import {
  assertItemTypeQuantityTrackable,
  assertNonNegativeInteger,
  findIdempotentReplay,
  logQuantityMovement,
} from "./quantity-entry-guards";

export class DrizzleTechnicianInventoryTransferRepository {
  constructor(private readonly executor: any) {}

  async getBalance(
    technicianId: string,
    itemTypeId: string,
    inventory: TransferInventoryType
  ): Promise<TechnicianInventoryBalance> {
    const table = this.getEntriesTable(inventory);

    const [entry] = await this.executor
      .select({
        boxes: table.boxes,
        units: table.units,
      })
      .from(table)
      .where(and(eq(table.technicianId, technicianId), eq(table.itemTypeId, itemTypeId)));

    return {
      boxes: entry?.boxes ?? 0,
      units: entry?.units ?? 0,
    };
  }

  async setBalance(
    technicianId: string,
    itemTypeId: string,
    inventory: TransferInventoryType,
    balance: TechnicianInventoryBalance
  ): Promise<void> {
    const table = this.getEntriesTable(inventory);

    const [existing] = await this.executor
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.technicianId, technicianId), eq(table.itemTypeId, itemTypeId)));

    if (existing) {
      await this.executor
        .update(table)
        .set({
          boxes: balance.boxes,
          units: balance.units,
          updatedAt: new Date(),
        })
        .where(eq(table.id, existing.id));
      return;
    }

    await this.executor.insert(table).values({
      technicianId,
      itemTypeId,
      boxes: balance.boxes,
      units: balance.units,
    });
  }

  async ensureTechnicianFixedInventory(technicianId: string): Promise<TechnicianFixedInventory> {
    const [existing] = await this.executor
      .select()
      .from(technicianFixedInventories)
      .where(eq(technicianFixedInventories.technicianId, technicianId));

    if (existing) {
      return existing;
    }

    const [created] = await this.executor
      .insert(technicianFixedInventories)
      .values({ technicianId })
      .returning();

    return created;
  }

  private getEntriesTable(inventory: TransferInventoryType) {
    return inventory === 'fixed'
      ? technicianFixedInventoryEntries
      : technicianMovingInventoryEntries;
  }

  async assertQuantityTrackable(itemTypeId: string, quantity: number): Promise<void> {
    await assertItemTypeQuantityTrackable(this.executor, itemTypeId);
    assertNonNegativeInteger(quantity, "الكمية");
  }

  async findIdempotentTransferReplay(idempotencyKey: string): Promise<{ matched: true } | null> {
    const replay = await findIdempotentReplay(this.executor, "stock_transfer", idempotencyKey);
    return replay ? { matched: true } : null;
  }

  async recordTransferMovement(params: {
    actor: { id: string; username: string; role: string };
    technicianId: string;
    itemTypeId: string;
    quantity: number;
    packagingType: string;
    fromInventory: TransferInventoryType;
    toInventory: TransferInventoryType;
    idempotencyKey: string;
  }): Promise<void> {
    await logQuantityMovement(this.executor, {
      actor: params.actor,
      action: "QUANTITY_UPDATE",
      entityType: "stock_transfer",
      entityId: `${params.technicianId}:${params.itemTypeId}:${params.fromInventory}->${params.toInventory}`,
      technicianId: params.technicianId,
      itemTypeId: params.itemTypeId,
      before: null,
      after: { boxes: params.quantity, units: 0 }, // quantity+packagingType carried in details below; before/after here only anchors the idempotency-replay match
      idempotencyKey: params.idempotencyKey,
      descriptionAr: `مناقلة ${params.quantity} ${params.packagingType} من ${params.fromInventory} إلى ${params.toInventory} لفني ${params.technicianId}`,
    });
  }
}
