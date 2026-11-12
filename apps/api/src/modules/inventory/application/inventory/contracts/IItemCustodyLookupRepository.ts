export type ItemCustody = {
  id: string;
  currentOwnerId: string | null;
  warehouseId: string | null;
};

export interface IItemCustodyLookupRepository {
  getCustodyById(itemId: string): Promise<ItemCustody | undefined>;
}
