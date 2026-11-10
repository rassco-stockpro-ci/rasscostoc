import { eq, and } from "drizzle-orm";
import { technicianMovingInventoryEntries } from "@shared/schema";

/**
 * Single source of truth for keeping `technician_moving_inventory_entries`
 * in sync with actual item custody changes. Every code path that sets
 * `items.currentOwnerId` to a technician (or clears it) for a serialized
 * item MUST call this in the same transaction — a path that skips it
 * produces an item the technician actually holds with no counter row at
 * all (confirmed historical defect: 4 technician/item-type pairs with
 * items but no entry row, surfacing as drift in every balance screen that
 * reads the counter table instead of deriving it from `items`).
 */
export async function syncMovingInventory(
  tx: any,
  technicianId: string | null | undefined,
  itemTypeId: string | null | undefined,
  delta: number,
): Promise<void> {
  if (!technicianId || !itemTypeId || delta === 0) return;

  const [existingEntry] = await tx
    .select()
    .from(technicianMovingInventoryEntries)
    .where(
      and(
        eq(technicianMovingInventoryEntries.technicianId, technicianId),
        eq(technicianMovingInventoryEntries.itemTypeId, itemTypeId),
      ),
    )
    .limit(1);

  if (existingEntry) {
    const newUnits = Math.max(0, existingEntry.units + delta);
    await tx
      .update(technicianMovingInventoryEntries)
      .set({
        units: newUnits,
        updatedAt: new Date(),
      })
      .where(eq(technicianMovingInventoryEntries.id, existingEntry.id));
  } else if (delta > 0) {
    await tx.insert(technicianMovingInventoryEntries).values({
      technicianId,
      itemTypeId,
      units: delta,
      boxes: 0,
    });
  }
}
