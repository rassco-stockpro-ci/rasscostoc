import { getDatabase } from "@core/database/connection";
import { outboxRepository } from "@core/outbox/outbox.repository";
import type { ICourierUnitOfWork, CourierTransactionalContext } from "../../domain/repositories/ICourierUnitOfWork";
import type { InventoryTransactionContext } from "../../domain/transaction";
import { DrizzleCourierRepository } from "./drizzle-courier.repository";

export class DrizzleCourierUnitOfWork implements ICourierUnitOfWork {
  async execute<T>(work: (context: CourierTransactionalContext) => Promise<T>): Promise<T> {
    const database = getDatabase();
    return database.transaction(async (tx) => {
      const repo = new DrizzleCourierRepository(tx);
      const context: CourierTransactionalContext = {
        requestsRepository: repo,
        executionsRepository: repo,
        pdfRepository: repo,
        dashboardRepository: repo,
        inventoryPort: repo,
        // The transaction contract (domain/transaction.ts): the only place a
        // concrete Drizzle transaction becomes the opaque handle the inventory
        // adapters unwrap, and the only outbox binding a close uses.
        inventoryTransaction: tx as unknown as InventoryTransactionContext,
        outbox: { enqueue: (event) => outboxRepository.enqueue(event, tx) },
        tx,
      };
      return work(context);
    });
  }
}
