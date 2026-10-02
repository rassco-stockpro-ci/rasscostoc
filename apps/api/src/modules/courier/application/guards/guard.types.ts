/**
 * Guard Validation Types
 * Shared types and errors for the Guard Validation Layer.
 */

import { AppError } from "@core/errors/AppError";
import type { ICourierRequestsRepository } from "../../domain/repositories/ICourierRequestsRepository";
import type { ICourierInventoryPort } from "../../domain/repositories/ICourierInventoryPort";
import type { ICourierDashboardReadRepository } from "../../domain/repositories/ICourierDashboardReadRepository";
import type { CloseUnitsPlan } from "../../domain/execution-unit";

/**
 * What a guard may do with the database: read, plus append the audit row of
 * a rejected validation. Nothing else is reachable through these types, so a
 * guard cannot gain a business-state write by accident (every state change of
 * a close is returned in the decision and applied inside the close
 * transaction).
 */
export type GuardRequestsReader = Pick<ICourierRequestsRepository, "findRequestItems">;
export type GuardInventoryReader = Pick<
  ICourierInventoryPort,
  | "findItemBySerial"
  | "findUserById"
  | "findUserByCodeOrUsername"
  | "findUserByFuzzyName"
  | "hasInventoryDeductionCompletion"
  | "getTechnicianConsumableBalances"
  | "findItemTypeById"
>;
/** The only write a guard performs: the append-only audit row of a rejection. */
export type GuardRejectionAudit = Pick<ICourierDashboardReadRepository, "insertAuditLog">;

/**
 * Context passed to all guards during execution validation.
 */
export interface GuardContext {
  requestId: number;
  enteredBy: string;
  /** The raw execution data submitted by the user */
  executionData: ExecutionInput;
  /** The original courier request from DB */
  request: RequestRecord;
  /** The existing execution record if any (for update path) */
  existingExecution?: ExistingExecution | null;
  requestsRepo: GuardRequestsReader;
  dashboardRepo: GuardRejectionAudit;
  inventoryPort: GuardInventoryReader;
}

export interface ExecutionInput {
  installationStatus?: string;
  technicianCode?: string;
  salesTechnician?: string;
  sn?: string;
  simSerial?: string;
  /** Extra devices beyond primary `sn` (portal multi-serial close). */
  deviceSerials?: string[];
  /** Extra SIMs beyond primary `simSerial` (portal multi-serial close). */
  simSerials?: string[];
  /** Installation units (units[] contract or PDF devices[]); absent = legacy fields above. */
  units?: CloseUnitsPlan;
  extraField1?: string;
  extraField2?: string;
  [key: string]: any;
}

/** True when a string looks like an inventory serial (not Flutter JSON metadata). */
export function looksLikeInventorySerial(value?: string | null): boolean {
  if (!value) return false;
  const t = String(value).trim();
  if (t.length < 6) return false;
  if (t.startsWith("{") || t.startsWith("[")) return false;
  return true;
}

/** Deduplicate and normalize serial lists from arrays and/or scalar fields. */
export function normalizeSerialList(
  ...sources: Array<string | string[] | null | undefined>
): string[] {
  const out: string[] = [];
  for (const src of sources) {
    const list = Array.isArray(src) ? src : src != null && src !== "" ? [src] : [];
    for (const raw of list) {
      const t = String(raw || "").trim();
      if (!looksLikeInventorySerial(t)) continue;
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

export interface RequestRecord {
  id: number;
  tecName?: string | null;
  customerName?: string | null;
  incidentNumber?: string | null;
  [key: string]: any;
}

export interface ExistingExecution {
  installationStatus?: string | null;
  [key: string]: any;
}

export interface TechUser {
  id: string;
  username: string;
  fullName: string;
}

/**
 * Thrown when a guard rejects the request.
 * No data should be written to DB after this error is thrown.
 * An AppError (422) so the rejection reason reaches the client; a plain Error
 * is masked as "Internal server error" by the production error handler.
 */
export class GuardValidationError extends AppError {
  public readonly field?: string;
  public readonly auditAction: string = "verification_failed";

  constructor(message: string, field?: string) {
    super(message, 422, true, "GUARD_VALIDATION_FAILED");
    this.name = "GuardValidationError";
    this.field = field;
  }
}

/** Statuses that trigger inventory deduction and full guard validation */
export const COMPLETED_STATUSES = new Set([
  "Installation Completed",
  "Installation Completed - NL",
]);

export function isCompletedStatus(status?: string): boolean {
  return !!status && COMPLETED_STATUSES.has(status);
}
