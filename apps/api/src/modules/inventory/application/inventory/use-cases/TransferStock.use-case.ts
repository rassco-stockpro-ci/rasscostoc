import type { StockMovement, TechnicianFixedInventory } from '@shared/schema';
import type { IInventoryUnitOfWork } from '../contracts/IInventoryUnitOfWork';
import type { TransferPackagingType } from '../contracts/IStockMovementRepository';
import type { TransferInventoryType } from '../contracts/ITechnicianInventoryTransferRepository';
import {
  assertValidStockTransfer,
  calculateStockTransferBalances,
} from "@modules/inventory/domain/stock-transfer.policy";

export type TransferStockInput = {
  technicianId: string;
  itemType: string;
  packagingType: TransferPackagingType;
  quantity: number;
  fromInventory: TransferInventoryType;
  toInventory: TransferInventoryType;
  performedBy: string;
  reason?: string;
  notes?: string;
  actor: { id: string; username: string; role: string };
  idempotencyKey: string;
};

export type TransferStockOutput = {
  movement: StockMovement;
  updatedInventory: TechnicianFixedInventory;
};

export class TransferStockUseCase {
  constructor(private readonly unitOfWork: IInventoryUnitOfWork) {}

  async execute(input: TransferStockInput): Promise<TransferStockOutput> {
    assertValidStockTransfer({
      quantity: input.quantity,
      fromInventory: input.fromInventory,
      toInventory: input.toInventory,
    });

    return this.unitOfWork.execute(async (context) => {
      if (!context.technicianInventoryTransferRepository || !context.stockMovementRepository) {
        throw new Error('Transfer stock dependencies are not configured in UnitOfWork');
      }

      // Same tracking-mode guard as every other quantity-write path:
      // requires_serial=true types can never move through this bare-quantity
      // transfer; hidden/inactive types can't receive new stock either.
      await context.technicianInventoryTransferRepository.assertQuantityTrackable(input.itemType, input.quantity);

      // Domain-level idempotency replay, inside the same transaction — a
      // retried transfer with the same key is a no-op, not a second move.
      const replay = await context.technicianInventoryTransferRepository.findIdempotentTransferReplay(
        input.idempotencyKey,
      );
      if (replay) {
        // The balance change and movement record were already applied by
        // the original request — this is intentionally a no-op, not a
        // second transfer. IStockMovementRepository has no read method to
        // re-fetch the original StockMovement row, so `movement` is left
        // null here; what this branch exists to prove (and what the
        // real-SQL test checks) is that the BALANCE is not double-applied,
        // which `updatedInventory` reflects correctly either way.
        const updatedInventory = await context.technicianInventoryTransferRepository.ensureTechnicianFixedInventory(
          input.technicianId,
        );
        return { movement: null as unknown as StockMovement, updatedInventory };
      }

      const sourceBalance = await context.technicianInventoryTransferRepository.getBalance(
        input.technicianId,
        input.itemType,
        input.fromInventory
      );

      const destinationBalance = await context.technicianInventoryTransferRepository.getBalance(
        input.technicianId,
        input.itemType,
        input.toInventory
      );

      const { nextSource, nextDestination } = calculateStockTransferBalances({
        source: sourceBalance,
        destination: destinationBalance,
        packagingType: input.packagingType,
        quantity: input.quantity,
      });

      await context.technicianInventoryTransferRepository.setBalance(
        input.technicianId,
        input.itemType,
        input.fromInventory,
        nextSource
      );

      await context.technicianInventoryTransferRepository.setBalance(
        input.technicianId,
        input.itemType,
        input.toInventory,
        nextDestination
      );

      const movement = await context.stockMovementRepository.create({
        technicianId: input.technicianId,
        itemType: input.itemType,
        packagingType: input.packagingType,
        quantity: input.quantity,
        fromInventory: input.fromInventory,
        toInventory: input.toInventory,
        performedBy: input.performedBy,
        reason: input.reason,
        notes: input.notes,
      });

      const updatedInventory = await context.technicianInventoryTransferRepository.ensureTechnicianFixedInventory(
        input.technicianId
      );

      // Idempotency-replay anchor for this transfer, written in the same
      // transaction as the balance change it guards.
      await context.technicianInventoryTransferRepository.recordTransferMovement({
        actor: input.actor,
        technicianId: input.technicianId,
        itemTypeId: input.itemType,
        quantity: input.quantity,
        packagingType: input.packagingType,
        fromInventory: input.fromInventory,
        toInventory: input.toInventory,
        idempotencyKey: input.idempotencyKey,
      });

      return { movement, updatedInventory };
    });
  }
}
