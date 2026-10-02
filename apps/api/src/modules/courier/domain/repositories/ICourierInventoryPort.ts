export interface ICourierInventoryPort {
  transferCustodyToTechnician(
    params: {
      itemId: string;
      technicianId: string;
      requestId: number;
      oldStatus: string;
      newStatus: "RECEIVED_BY_TECHNICIAN" | "IN_TRANSIT";
    },
    tx?: any
  ): Promise<void>;

  mintAndAssignToTechnician(
    params: {
      serial: string;
      itemTypeId: string;
      carrierName: string | null;
      technicianId: string;
      requestId: number;
    },
    tx?: any
  ): Promise<{ id: string; serialNumber: string }>;

  normalizeSerial(
    serial: string,
    hintItemTypeId: string,
    tx?: any
  ): Promise<{
    normalizedSerial: string;
    itemTypeId: string;
    carrierName: string | null;
  }>;

  findItemBySerial(serial: string, tx?: any): Promise<any | null>;
  findItemTypeById(itemTypeId: string, tx?: any): Promise<{ id: string; nameAr: string; nameEn: string; category: string } | null>;
  findUserById(userId: string, tx?: any): Promise<{ id: string; fullName: string; username: string; technicianCode: string | null; role: string; regionId: number | null } | null>;
  findUserByCodeOrUsername(code: string, tx?: any): Promise<{ id: string; fullName: string; username: string; technicianCode: string | null } | null>;
  findUserByFuzzyName(name: string, tx?: any): Promise<{ id: string; fullName: string; username: string; technicianCode: string | null } | null>;
  findLinkedRequestItemBySerial(serial: string, tx?: any): Promise<{ requestId: number; id: number; itemType: string; status: string } | null>;

  /**
   * Broad fuzzy fallback search used by serialLookup when the exact-match
   * lookup finds nothing (matches serial/simSerial/barcode, exact or partial).
   */
  searchItemFallbackBySerial(rawSerial: string, tx?: any): Promise<{
    id: string;
    serialNumber: string;
    carrierName: string | null;
    status: string;
    currentOwnerId: string | null;
    technicianName: string | null;
    technicianCode: string | null;
  } | null>;

  /**
   * Consumable balances per itemTypeId: every moving and fixed inventory row of
   * the technician for that item type, plus the item type's unitsPerBox.
   */
  getTechnicianConsumableBalances(
    technicianId: string,
    itemTypeIds: string[],
    tx?: any
  ): Promise<Record<string, { unitsPerBox: number; buckets: { boxes: number; units: number }[] }>>;

  /** True once InventoryEngine has durably completed the deduction for this request. */
  hasInventoryDeductionCompletion(requestId: number, tx?: any): Promise<boolean>;

  linkSimToTechnician(data: {
    simSerial: string;
    simType?: string;
    technicianId?: string;
    technicianUsername?: string;
    notes?: string;
  }, tx?: any): Promise<{ success: boolean; message: string; item: any }>;
}
