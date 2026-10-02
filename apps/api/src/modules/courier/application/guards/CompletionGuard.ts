/**
 * CompletionGuard — Guard Orchestrator
 *
 * The single entry point for the Guard Validation Layer.
 * Runs all guards in the correct order before any DB write.
 *
 * Order:
 *   1. ExecutionGuard  — structural completeness
 *   2. TechnicianGuard — technician identity resolution
 *   3. CustodyGuard    — custody ownership + IN_TRANSIT_CUSTODY
 *   4. ConsumablesGuard — technician balance covers the consumables entered
 *
 * If any guard throws, the entire operation is rejected.
 * Guards only read; the one write a guard performs is CustodyGuard's audit
 * row for a failed custody check (an append-only record of the rejection).
 * Every state change the close needs is returned in the decision and
 * applied by the caller inside its transaction.
 *
 * Usage:
 *   const decision = await CompletionGuard.run(ctx);
 *   // inside the close transaction: bind decision.requestItemsToBind, deduct decision.closeItems...
 */

import { ExecutionGuard } from "./ExecutionGuard";
import { TechnicianGuard } from "./TechnicianGuard";
import { CustodyGuard, type CloseItem, type RequestItemBinding, type UnitCountWarning } from "./CustodyGuard";
import type { PairingSource, ResolvedCloseUnit } from "../../domain/execution-unit";
import { ConsumablesGuard } from "./ConsumablesGuard";
import type { GuardContext, TechUser } from "./guard.types";

export { GuardValidationError, isCompletedStatus } from "./guard.types";
export type { GuardContext, TechUser } from "./guard.types";
export type { CloseItem, RequestItemBinding, UnitCountWarning } from "./CustodyGuard";

export interface CompletionDecision {
  /** Resolved technician when the status is completed, null otherwise. */
  techUser: TechUser | null;
  /** Serials validated for THIS close — the only serials its deduction may touch. */
  closeItems: CloseItem[];
  /** courier_request_items rows to create inside the close transaction. */
  requestItemsToBind: RequestItemBinding[];
  /** The installation units (device [+ SIM]) this close installs, resolved to inventory items. */
  units: ResolvedCloseUnit[];
  pairingSource: PairingSource | null;
  countWarning: UnitCountWarning | null;
}

export class CompletionGuard {
  /**
   * Run all guards for an execution save operation.
   *
   * @throws GuardValidationError if any guard fails.
   */
  static async run(ctx: GuardContext): Promise<CompletionDecision> {
    // 1. Structural validation (sync — no DB)
    ExecutionGuard.validate(ctx);

    // 2. Technician identity resolution (async — DB lookup)
    const techUser = await TechnicianGuard.resolve(ctx);
    if (!techUser) {
      return { techUser: null, closeItems: [], requestItemsToBind: [], units: [], pairingSource: null, countWarning: null };
    }

    // 3. Custody validation (async — DB lookup + audit log on failure)
    const custody = await CustodyGuard.validate(ctx, techUser);
    // 4. Consumables balance (async — DB lookup)
    await ConsumablesGuard.validate(ctx, techUser);

    return {
      techUser,
      closeItems: custody.items,
      requestItemsToBind: custody.requestItemsToBind,
      units: custody.units,
      pairingSource: custody.pairingSource,
      countWarning: custody.countWarning,
    };
  }
}
