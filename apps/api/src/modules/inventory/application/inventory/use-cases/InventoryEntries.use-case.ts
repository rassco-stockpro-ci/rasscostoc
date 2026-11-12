import type {
  TechnicianFixedInventoryEntry,
  TechnicianMovingInventoryEntry,
  WarehouseInventoryEntry,
} from "@shared/schema";
import type { IInventoryEntriesRepository, InventoryEntryActor, InventoryEntryInput } from '../contracts/IInventoryEntriesRepository';
import { ValidationError } from "@core/errors/AppError";

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
    actor: InventoryEntryActor,
    idempotencyKey: string,
  ): Promise<TechnicianMovingInventoryEntry> {
    return this.repository.upsertTechnicianMovingEntry(technicianId, input, actor, idempotencyKey);
  }

  async upsertTechnicianMovingEntriesBatch(
    technicianId: string,
    entries: InventoryEntryInput[],
    actor: InventoryEntryActor,
    idempotencyKey: string,
  ): Promise<TechnicianMovingInventoryEntry[]> {
    if (!idempotencyKey || idempotencyKey.trim().length < 10) {
      throw new ValidationError(
        "يتطلب تحديث المخزون المتحرك ترويسة X-Idempotency-Key صالحة (10 أحرف على الأقل) لمنع تنفيذ العملية مرتين",
      );
    }

    const results: TechnicianMovingInventoryEntry[] = [];

    // Each entry in the batch gets its own stable, deterministic sub-key
    // derived from the request-level key + its index, so retrying the
    // WHOLE batch with the same header replays every entry idempotently
    // (not just the first), without requiring the client to send an array
    // of keys.
    for (let i = 0; i < entries.length; i++) {
      const result = await this.repository.upsertTechnicianMovingEntry(
        technicianId,
        entries[i],
        actor,
        `${idempotencyKey}:${i}`,
      );
      results.push(result);
    }

    return results;
  }
}
