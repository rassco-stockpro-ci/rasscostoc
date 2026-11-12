import { DrizzleItemCustodyLookupRepository } from "@modules/inventory/infrastructure/database/DrizzleItemCustodyLookupRepository";

class ItemCustodyLookupContainer {
  readonly itemCustodyLookupRepository = new DrizzleItemCustodyLookupRepository();
}

export const itemCustodyLookupContainer = new ItemCustodyLookupContainer();
