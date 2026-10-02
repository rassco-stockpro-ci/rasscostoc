/**
 * Transaction contract between the courier application layer (a close) and
 * the inventory deduction it commits with.
 *
 * A close runs in one CourierTransactionalContext. That context hands the
 * application two capabilities bound to the same database transaction:
 *
 *   inventoryTransaction  an opaque handle InventoryEngine.executePrepared()
 *                         runs its writes in; only infrastructure can create
 *                         one, the application only passes it along
 *   outbox                durable event enqueue on that transaction (no
 *                         in-memory fallback: if the enqueue fails, the
 *                         transaction fails)
 *
 * Neither exposes the database client, so application code never casts a
 * concrete Drizzle transaction.
 */
import type { IEvent } from "@core/events/event.types";

/** Opaque transaction handle; created by infrastructure only. */
export interface InventoryTransactionContext {
  readonly __brand: unique symbol;
}

/** Transactional outbox bound to the current transaction. */
export interface TransactionalOutbox {
  enqueue(event: IEvent): Promise<void>;
}
