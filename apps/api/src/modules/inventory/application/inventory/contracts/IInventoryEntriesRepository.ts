import type {
  TechnicianFixedInventoryEntry,
  TechnicianMovingInventoryEntry,
  WarehouseInventoryEntry,
} from "@shared/schema";

export type InventoryEntryInput = {
  itemTypeId: string;
  boxes: number;
  units: number;
  /** Last `version` the caller observed; enables optimistic-lock rejection of stale writes. Omitted = lock not enforced (back-compat for callers not yet updated). An integer, not a timestamp — see schema comment for why. */
  expectedVersion?: number | null;
};

export type InventoryEntryActor = {
  id: string;
  username: string;
  role: string;
};

export interface IInventoryEntriesRepository {
  getWarehouseEntries(warehouseId: string): Promise<WarehouseInventoryEntry[]>;
  upsertWarehouseEntry(warehouseId: string, input: InventoryEntryInput): Promise<WarehouseInventoryEntry>;

  getTechnicianFixedEntries(technicianId: string): Promise<TechnicianFixedInventoryEntry[]>;
  upsertTechnicianFixedEntry(
    technicianId: string,
    input: InventoryEntryInput,
    actor: InventoryEntryActor,
    idempotencyKey: string,
  ): Promise<TechnicianFixedInventoryEntry>;

  getTechnicianMovingEntries(technicianId: string): Promise<TechnicianMovingInventoryEntry[]>;
  upsertTechnicianMovingEntry(technicianId: string, input: InventoryEntryInput): Promise<TechnicianMovingInventoryEntry>;
}
