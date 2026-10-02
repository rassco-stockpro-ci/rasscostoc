import type { ICourierRequestsRepository } from "./ICourierRequestsRepository";
import type { ICourierExecutionsRepository } from "./ICourierExecutionsRepository";
import type { ICourierPdfRepository } from "./ICourierPdfRepository";
import type { ICourierDashboardReadRepository } from "./ICourierDashboardReadRepository";
import type { ICourierInventoryPort } from "./ICourierInventoryPort";
import type { InventoryTransactionContext, TransactionalOutbox } from "../transaction";

export type CourierTransactionalContext = {
  requestsRepository: ICourierRequestsRepository;
  executionsRepository: ICourierExecutionsRepository;
  pdfRepository: ICourierPdfRepository;
  dashboardRepository: ICourierDashboardReadRepository;
  inventoryPort: ICourierInventoryPort;
  /** Durable event enqueue on this transaction (domain/transaction.ts). */
  outbox: TransactionalOutbox;
  /** This transaction as the inventory deduction layer's handle (domain/transaction.ts). */
  inventoryTransaction: InventoryTransactionContext;
  /**
   * The raw database transaction. Legacy: only EventBus.publish(event, tx)
   * call sites still use it; new code uses `outbox` / `inventoryTransaction`.
   */
  tx?: any;
};

export interface ICourierUnitOfWork {
  execute<T>(work: (context: CourierTransactionalContext) => Promise<T>): Promise<T>;
}
export interface ICourierTransactionPort {
  run<T>(work: (tx: any) => Promise<T>): Promise<T>;
}
