import type { TechnicianFixedInventory } from '@shared/schema';

import { TechnicianInventoryBalance } from '../../../domain/stock-transfer.types';
export { TechnicianInventoryBalance };

export type TransferInventoryType = 'fixed' | 'moving';

export interface ITechnicianInventoryTransferRepository {
  getBalance(
    technicianId: string,
    itemTypeId: string,
    inventory: TransferInventoryType
  ): Promise<TechnicianInventoryBalance>;
  setBalance(
    technicianId: string,
    itemTypeId: string,
    inventory: TransferInventoryType,
    balance: TechnicianInventoryBalance
  ): Promise<void>;
  ensureTechnicianFixedInventory(technicianId: string): Promise<TechnicianFixedInventory>;

  /** Same tracking-mode/quantity-integrity guard shared with every other quantity-write path (see quantity-entry-guards.ts). Throws ValidationError if the type is serialized/hidden/inactive, or the quantity isn't a non-negative integer. */
  assertQuantityTrackable(itemTypeId: string, quantity: number): Promise<void>;

  /** Domain-level idempotency-replay check inside the same transaction — see quantity-entry-guards.ts for why this is separate from the HTTP-level cache. */
  findIdempotentTransferReplay(idempotencyKey: string): Promise<{ matched: true } | null>;

  /** Records the transfer movement for audit + idempotency-replay dedup, inside the same transaction as the balance updates. */
  recordTransferMovement(params: {
    actor: { id: string; username: string; role: string };
    technicianId: string;
    itemTypeId: string;
    quantity: number;
    packagingType: string;
    fromInventory: TransferInventoryType;
    toInventory: TransferInventoryType;
    idempotencyKey: string;
  }): Promise<void>;
}
