import { describe, expect, it, vi } from 'vitest';
import type {
  TechnicianFixedInventoryEntry,
  TechnicianMovingInventoryEntry,
  WarehouseInventoryEntry,
} from "@shared/schema";
import type { IInventoryEntriesRepository } from '../contracts/IInventoryEntriesRepository';
import { InventoryEntriesUseCase } from './InventoryEntries.use-case';

type MockRepository = {
  [K in keyof IInventoryEntriesRepository]: ReturnType<typeof vi.fn>;
};

function createRepositoryMock(): MockRepository {
  return {
    getWarehouseEntries: vi.fn(),
    upsertWarehouseEntry: vi.fn(),
    getTechnicianFixedEntries: vi.fn(),
    upsertTechnicianFixedEntry: vi.fn(),
    getTechnicianMovingEntries: vi.fn(),
    upsertTechnicianMovingEntry: vi.fn(),
  };
}

function warehouseEntryFixture(overrides: Partial<WarehouseInventoryEntry> = {}): WarehouseInventoryEntry {
  return {
    id: 'w-entry-1',
    warehouseId: 'wh-1',
    itemTypeId: 'n950',
    boxes: 1,
    units: 2,
    updatedAt: new Date(),
    ...overrides,
  };
}

function technicianFixedEntryFixture(
  overrides: Partial<TechnicianFixedInventoryEntry> = {},
): TechnicianFixedInventoryEntry {
  return {
    id: 'f-entry-1',
    technicianId: 'tech-1',
    itemTypeId: 'n950',
    boxes: 1,
    units: 2,
    updatedAt: new Date(),
    ...overrides,
  };
}

function technicianMovingEntryFixture(
  overrides: Partial<TechnicianMovingInventoryEntry> = {},
): TechnicianMovingInventoryEntry {
  return {
    id: 'm-entry-1',
    technicianId: 'tech-1',
    itemTypeId: 'n950',
    boxes: 1,
    units: 2,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('InventoryEntriesUseCase', () => {
  it('delegates warehouse entry read and upsert', async () => {
    const repository = createRepositoryMock();
    const useCase = new InventoryEntriesUseCase(repository);
    repository.getWarehouseEntries.mockResolvedValue([warehouseEntryFixture()]);
    repository.upsertWarehouseEntry.mockResolvedValue(warehouseEntryFixture({ boxes: 5, units: 6 }));

    const readResult = await useCase.getWarehouseEntries('wh-1');
    const upsertResult = await useCase.upsertWarehouseEntry('wh-1', {
      itemTypeId: 'n950',
      boxes: 5,
      units: 6,
    });

    expect(readResult).toHaveLength(1);
    expect(upsertResult.boxes).toBe(5);
    expect(repository.getWarehouseEntries).toHaveBeenCalledWith('wh-1');
    expect(repository.upsertWarehouseEntry).toHaveBeenCalledWith('wh-1', {
      itemTypeId: 'n950',
      boxes: 5,
      units: 6,
    });
  });

  it('delegates technician fixed/moving reads and batch moving upserts in order', async () => {
    const repository = createRepositoryMock();
    const useCase = new InventoryEntriesUseCase(repository);
    repository.getTechnicianFixedEntries.mockResolvedValue([technicianFixedEntryFixture()]);
    repository.getTechnicianMovingEntries.mockResolvedValue([technicianMovingEntryFixture()]);
    repository.upsertTechnicianMovingEntry
      .mockResolvedValueOnce(technicianMovingEntryFixture({ id: 'm-1', itemTypeId: 'n950' }))
      .mockResolvedValueOnce(technicianMovingEntryFixture({ id: 'm-2', itemTypeId: 'i9100' }));

    const actor = { id: 'admin-1', username: 'admin', role: 'admin' };

    const fixed = await useCase.getTechnicianFixedEntries('tech-1');
    const moving = await useCase.getTechnicianMovingEntries('tech-1');
    const batch = await useCase.upsertTechnicianMovingEntriesBatch(
      'tech-1',
      [
        { itemTypeId: 'n950', boxes: 1, units: 0 },
        { itemTypeId: 'i9100', boxes: 0, units: 2 },
      ],
      actor,
      'batch-test-idempotency-key-0001',
    );

    expect(fixed).toHaveLength(1);
    expect(moving).toHaveLength(1);
    expect(batch).toHaveLength(2);
    expect(batch[0].id).toBe('m-1');
    expect(batch[1].id).toBe('m-2');
    expect(repository.upsertTechnicianMovingEntry).toHaveBeenNthCalledWith(
      1,
      'tech-1',
      { itemTypeId: 'n950', boxes: 1, units: 0 },
      actor,
      'batch-test-idempotency-key-0001:0',
    );
    expect(repository.upsertTechnicianMovingEntry).toHaveBeenNthCalledWith(
      2,
      'tech-1',
      { itemTypeId: 'i9100', boxes: 0, units: 2 },
      actor,
      'batch-test-idempotency-key-0001:1',
    );
  });
});
