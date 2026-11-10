import type {
  TechnicianFixedInventoryEntry,
  TechnicianMovingInventoryEntry,
  WarehouseInventoryEntry,
} from "@shared/schema";
import type { IInventoryEntriesRepository, InventoryEntryActor, InventoryEntryInput } from '../contracts/IInventoryEntriesRepository';

export class InventoryEntriesUseCase {
  constructor(private readonly repository: IInventoryEntriesRepository) {}

  async getWarehouseEntries(warehouseId: string): Promise<WarehouseInventoryEntry[]> {
    return this.repository.getWarehouseEntries(warehouseId);
  }

  async upsertWarehouseEntry(warehouseId: string, input: InventoryEntryInput): Promise<WarehouseInventoryEntry> {
    return this.repository.upsertWarehouseEntry(warehouseId, input);
  }

  async getTechnicianFixedEntries(technicianId: string): Promise<TechnicianFixedInventoryEntry[]> {
    return this.repository.getTechnicianFixedEntries(technicianId);
  }

  async upsertTechnicianFixedEntry(
    technicianId: string,
    input: InventoryEntryInput,
    actor: InventoryEntryActor,
    idempotencyKey: string,
  ): Promise<TechnicianFixedInventoryEntry> {
    return this.repository.upsertTechnicianFixedEntry(technicianId, input, actor, idempotencyKey);
  }

  async getTechnicianMovingEntries(technicianId: string): Promise<TechnicianMovingInventoryEntry[]> {
    return this.repository.getTechnicianMovingEntries(technicianId);
  }

  async upsertTechnicianMovingEntry(
    technicianId: string,
    input: InventoryEntryInput,
  ): Promise<TechnicianMovingInventoryEntry> {
    return this.repository.upsertTechnicianMovingEntry(technicianId, input);
  }

  async upsertTechnicianMovingEntriesBatch(
    technicianId: string,
    entries: InventoryEntryInput[],
  ): Promise<TechnicianMovingInventoryEntry[]> {
    const results: TechnicianMovingInventoryEntry[] = [];

    for (const entry of entries) {
      const result = await this.repository.upsertTechnicianMovingEntry(technicianId, entry);
      results.push(result);
    }

    return results;
  }
}
