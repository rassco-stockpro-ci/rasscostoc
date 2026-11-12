import type { StockMovementWithDetails } from '@shared/schema';
import type { StockMovement, TechnicianFixedInventory } from "@shared/schema";

export type StockTransferInput = {
  technicianId: string;
  itemType: string;
  packagingType: 'box' | 'unit';
  quantity: number;
  fromInventory: 'fixed' | 'moving';
  toInventory: 'fixed' | 'moving';
  performedBy: string;
  reason?: string;
  notes?: string;
  actor: { id: string; username: string; role: string };
  idempotencyKey: string;
};

export type StockTransferOutput = {
  movement: StockMovement;
  updatedInventory: TechnicianFixedInventory;
};

export interface IStockTransferRepository {
  transferStock(input: StockTransferInput): Promise<StockTransferOutput>;
  getStockMovements(technicianId?: string, limit?: number): Promise<StockMovementWithDetails[]>;
}
