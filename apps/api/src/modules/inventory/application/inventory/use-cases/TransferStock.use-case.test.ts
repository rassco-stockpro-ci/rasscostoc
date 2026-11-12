import { describe, expect, it } from 'vitest';
import type { InventoryItem, StockMovement, TechnicianFixedInventory } from '@shared/schema';
import type { IInventoryRepository } from '../contracts/IInventoryRepository';
import type {
  CreateInventoryTransactionInput,
  IInventoryTransactionLogRepository,
} from '../contracts/IInventoryTransactionLogRepository';
import type { IInventoryUnitOfWork } from '../contracts/IInventoryUnitOfWork';
import type {
  ITechnicianInventoryTransferRepository,
  TechnicianInventoryBalance,
  TransferInventoryType,
} from '../contracts/ITechnicianInventoryTransferRepository';
import type {
  CreateStockMovementInput,
  IStockMovementRepository,
} from '../contracts/IStockMovementRepository';
import { TransferStockUseCase } from './TransferStock.use-case';
import { InsufficientStockError } from "@modules/inventory/domain/inventory-item.aggregate";
import { SameInventoryTransferError } from "@modules/inventory/domain/stock-transfer.policy";

class NoopInventoryRepository implements IInventoryRepository {
  async findById(): Promise<{ id: string; quantity: number } | undefined> {
    return undefined;
  }

  async updateQuantity(): Promise<InventoryItem> {
    throw new Error('Not implemented in this test');
  }
}

class NoopTransactionRepository implements IInventoryTransactionLogRepository {
  async create(_input: CreateInventoryTransactionInput): Promise<void> {
    return;
  }
}

function fixedInventoryFixture(technicianId: string): TechnicianFixedInventory {
  return {
    id: 'fixed-inv-1',
    technicianId,
    n950Boxes: 0,
    n950Units: 0,
    i9000sBoxes: 0,
    i9000sUnits: 0,
    i9100Boxes: 0,
    i9100Units: 0,
    rollPaperBoxes: 0,
    rollPaperUnits: 0,
    stickersBoxes: 0,
    stickersUnits: 0,
    newBatteriesBoxes: 0,
    newBatteriesUnits: 0,
    mobilySimBoxes: 0,
    mobilySimUnits: 0,
    stcSimBoxes: 0,
    stcSimUnits: 0,
    zainSimBoxes: 0,
    zainSimUnits: 0,
    lebaraBoxes: 0,
    lebaraUnits: 0,
    lowStockThreshold: 30,
    criticalStockThreshold: 70,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

class InMemoryTransferRepository implements ITechnicianInventoryTransferRepository {
  private balances = new Map<string, TechnicianInventoryBalance>();
  private inventories = new Map<string, TechnicianFixedInventory>();

  constructor(seedBalances: Array<{ key: string; value: TechnicianInventoryBalance }> = []) {
    for (const seed of seedBalances) {
      this.balances.set(seed.key, { ...seed.value });
    }
  }

  static key(technicianId: string, itemTypeId: string, inventory: TransferInventoryType): string {
    return `${inventory}:${technicianId}:${itemTypeId}`;
  }

  async getBalance(
    technicianId: string,
    itemTypeId: string,
    inventory: TransferInventoryType
  ): Promise<TechnicianInventoryBalance> {
    return this.balances.get(InMemoryTransferRepository.key(technicianId, itemTypeId, inventory)) || {
      boxes: 0,
      units: 0,
    };
  }

  async setBalance(
    technicianId: string,
    itemTypeId: string,
    inventory: TransferInventoryType,
    balance: TechnicianInventoryBalance
  ): Promise<void> {
    this.balances.set(InMemoryTransferRepository.key(technicianId, itemTypeId, inventory), { ...balance });
  }

  async ensureTechnicianFixedInventory(technicianId: string): Promise<TechnicianFixedInventory> {
    const existing = this.inventories.get(technicianId);
    if (existing) return existing;

    const created = fixedInventoryFixture(technicianId);
    this.inventories.set(technicianId, created);
    return created;
  }

  private replayedKeys = new Set<string>();

  async assertQuantityTrackable(_itemTypeId: string, _quantity: number): Promise<void> {
    // Test double: the requires_serial/hidden/integer DB lookup is covered
    // by the real-SQL guard tests (quantity-entry-guards + the PGlite
    // suites) — this in-memory fake has no item_types table to check
    // against, so it's a deliberate no-op here, not a gap in coverage.
  }

  async findIdempotentTransferReplay(idempotencyKey: string): Promise<{ matched: true } | null> {
    return this.replayedKeys.has(idempotencyKey) ? { matched: true } : null;
  }

  async recordTransferMovement(params: { idempotencyKey: string }): Promise<void> {
    this.replayedKeys.add(params.idempotencyKey);
  }

  clone(): InMemoryTransferRepository {
    const cloned = new InMemoryTransferRepository();
    for (const [key, value] of this.balances.entries()) {
      cloned.balances.set(key, { ...value });
    }
    for (const [key, value] of this.inventories.entries()) {
      cloned.inventories.set(key, { ...value });
    }
    cloned.replayedKeys = new Set(this.replayedKeys);
    return cloned;
  }

  applyFrom(source: InMemoryTransferRepository): void {
    this.balances = new Map(source.balances);
    this.inventories = new Map(source.inventories);
    this.replayedKeys = new Set(source.replayedKeys);
  }
}

class InMemoryStockMovementRepository implements IStockMovementRepository {
  readonly movements: StockMovement[] = [];
  shouldFail = false;

  async create(input: CreateStockMovementInput): Promise<StockMovement> {
    if (this.shouldFail) {
      throw new Error('Failed to create stock movement');
    }

    const movement: StockMovement = {
      id: `movement-${this.movements.length + 1}`,
      technicianId: input.technicianId,
      itemType: input.itemType,
      packagingType: input.packagingType,
      quantity: input.quantity,
      fromInventory: input.fromInventory,
      toInventory: input.toInventory,
      reason: input.reason ?? null,
      performedBy: input.performedBy,
      notes: input.notes ?? null,
      createdAt: new Date(),
    };

    this.movements.push(movement);
    return movement;
  }

  clone(): InMemoryStockMovementRepository {
    const cloned = new InMemoryStockMovementRepository();
    cloned.shouldFail = this.shouldFail;
    cloned.movements.push(...this.movements.map((movement) => ({ ...movement })));
    return cloned;
  }

  applyFrom(source: InMemoryStockMovementRepository): void {
    this.shouldFail = source.shouldFail;
    this.movements.length = 0;
    this.movements.push(...source.movements.map((movement) => ({ ...movement })));
  }
}

class TransactionalFakeInventoryUnitOfWork implements IInventoryUnitOfWork {
  constructor(
    private readonly transferRepo: InMemoryTransferRepository,
    private readonly stockMovementRepo: InMemoryStockMovementRepository
  ) {}

  async execute<T>(work: (context: any) => Promise<T>): Promise<T> {
    const transferClone = this.transferRepo.clone();
    const movementClone = this.stockMovementRepo.clone();

    try {
      const result = await work({
        inventoryRepository: new NoopInventoryRepository(),
        transactionLogRepository: new NoopTransactionRepository(),
        technicianInventoryTransferRepository: transferClone,
        stockMovementRepository: movementClone,
      });

      this.transferRepo.applyFrom(transferClone);
      this.stockMovementRepo.applyFrom(movementClone);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

describe('TransferStockUseCase', () => {
  it('transfers stock between inventories and creates movement', async () => {
    const technicianId = 'tech-1';
    const itemTypeId = 'n950';
    const transferRepo = new InMemoryTransferRepository([
      {
        key: InMemoryTransferRepository.key(technicianId, itemTypeId, 'fixed'),
        value: { boxes: 10, units: 5 },
      },
      {
        key: InMemoryTransferRepository.key(technicianId, itemTypeId, 'moving'),
        value: { boxes: 1, units: 2 },
      },
    ]);
    const movementRepo = new InMemoryStockMovementRepository();
    const unitOfWork = new TransactionalFakeInventoryUnitOfWork(transferRepo, movementRepo);
    const useCase = new TransferStockUseCase(unitOfWork);

    const result = await useCase.execute({
      technicianId,
      itemType: itemTypeId,
      packagingType: 'box',
      quantity: 3,
      fromInventory: 'fixed',
      toInventory: 'moving',
      performedBy: 'admin-1',
      actor: { id: 'admin-1', username: 'admin', role: 'admin' },
      idempotencyKey: 'transfer-test-key-0001',
      reason: 'Rebalance',
    });

    expect(result.movement.quantity).toBe(3);
    expect(result.updatedInventory.technicianId).toBe(technicianId);
    expect(movementRepo.movements).toHaveLength(1);

    await expect(transferRepo.getBalance(technicianId, itemTypeId, 'fixed')).resolves.toEqual({
      boxes: 7,
      units: 5,
    });
    await expect(transferRepo.getBalance(technicianId, itemTypeId, 'moving')).resolves.toEqual({
      boxes: 4,
      units: 2,
    });
  });

  it('fails when source and destination are the same', async () => {
    const transferRepo = new InMemoryTransferRepository();
    const movementRepo = new InMemoryStockMovementRepository();
    const unitOfWork = new TransactionalFakeInventoryUnitOfWork(transferRepo, movementRepo);
    const useCase = new TransferStockUseCase(unitOfWork);

    await expect(
      useCase.execute({
        technicianId: 'tech-1',
        itemType: 'n950',
        packagingType: 'box',
        quantity: 1,
        fromInventory: 'fixed',
        toInventory: 'fixed',
        performedBy: 'admin-1',
        actor: { id: 'admin-1', username: 'admin', role: 'admin' },
        idempotencyKey: 'transfer-test-key-0002',
      })
    ).rejects.toThrowError(SameInventoryTransferError);
  });

  it('fails cleanly when source stock is insufficient and does not write movement', async () => {
    const technicianId = 'tech-1';
    const itemTypeId = 'n950';
    const transferRepo = new InMemoryTransferRepository([
      {
        key: InMemoryTransferRepository.key(technicianId, itemTypeId, 'fixed'),
        value: { boxes: 1, units: 0 },
      },
      {
        key: InMemoryTransferRepository.key(technicianId, itemTypeId, 'moving'),
        value: { boxes: 2, units: 0 },
      },
    ]);
    const movementRepo = new InMemoryStockMovementRepository();
    const unitOfWork = new TransactionalFakeInventoryUnitOfWork(transferRepo, movementRepo);
    const useCase = new TransferStockUseCase(unitOfWork);

    await expect(
      useCase.execute({
        technicianId,
        itemType: itemTypeId,
        packagingType: 'box',
        quantity: 2,
        fromInventory: 'fixed',
        toInventory: 'moving',
        performedBy: 'admin-1',
        actor: { id: 'admin-1', username: 'admin', role: 'admin' },
        idempotencyKey: 'transfer-test-key-0003',
      })
    ).rejects.toThrowError(InsufficientStockError);

    expect(movementRepo.movements).toHaveLength(0);
    await expect(transferRepo.getBalance(technicianId, itemTypeId, 'fixed')).resolves.toEqual({
      boxes: 1,
      units: 0,
    });
    await expect(transferRepo.getBalance(technicianId, itemTypeId, 'moving')).resolves.toEqual({
      boxes: 2,
      units: 0,
    });
  });

  it('rolls back balance changes when movement creation fails', async () => {
    const technicianId = 'tech-1';
    const itemTypeId = 'n950';
    const transferRepo = new InMemoryTransferRepository([
      {
        key: InMemoryTransferRepository.key(technicianId, itemTypeId, 'fixed'),
        value: { boxes: 5, units: 0 },
      },
      {
        key: InMemoryTransferRepository.key(technicianId, itemTypeId, 'moving'),
        value: { boxes: 1, units: 0 },
      },
    ]);
    const movementRepo = new InMemoryStockMovementRepository();
    movementRepo.shouldFail = true;
    const unitOfWork = new TransactionalFakeInventoryUnitOfWork(transferRepo, movementRepo);
    const useCase = new TransferStockUseCase(unitOfWork);

    await expect(
      useCase.execute({
        technicianId,
        itemType: itemTypeId,
        packagingType: 'box',
        quantity: 2,
        fromInventory: 'fixed',
        toInventory: 'moving',
        performedBy: 'admin-1',
        actor: { id: 'admin-1', username: 'admin', role: 'admin' },
        idempotencyKey: 'transfer-test-key-0004',
      })
    ).rejects.toThrowError('Failed to create stock movement');

    await expect(transferRepo.getBalance(technicianId, itemTypeId, 'fixed')).resolves.toEqual({
      boxes: 5,
      units: 0,
    });
    await expect(transferRepo.getBalance(technicianId, itemTypeId, 'moving')).resolves.toEqual({
      boxes: 1,
      units: 0,
    });
    expect(movementRepo.movements).toHaveLength(0);
  });
});
