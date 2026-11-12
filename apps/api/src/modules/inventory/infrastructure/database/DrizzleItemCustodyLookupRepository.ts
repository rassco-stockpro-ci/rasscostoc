import { eq } from "drizzle-orm";
import { getDatabase } from "@core/database/connection";
import { items } from "@shared/schema";
import type {
  IItemCustodyLookupRepository,
  ItemCustody,
} from "@modules/inventory/application/inventory/contracts/IItemCustodyLookupRepository";

export class DrizzleItemCustodyLookupRepository implements IItemCustodyLookupRepository {
  async getCustodyById(itemId: string): Promise<ItemCustody | undefined> {
    const [row] = await getDatabase()
      .select({ id: items.id, currentOwnerId: items.currentOwnerId, warehouseId: items.warehouseId })
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1);
    return row ?? undefined;
  }
}
