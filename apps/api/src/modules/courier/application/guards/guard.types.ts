/**
 * Guard Validation Types
 * Shared types and errors for the Guard Validation Layer.
 */

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
  requestsRepo: any;
  dashboardRepo: any;
  inventoryPort: any;
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

import { AppError } from "@core/errors/AppError";

/**
 * Thrown when a guard rejects the request.
 * No data should be written to DB after this error is thrown.
 * Extends AppError so the global error handler returns 422 instead of 500.
 */
export class GuardValidationError extends AppError {
  public readonly field?: string;
  public readonly auditAction: string = "verification_failed";

  constructor(message: string, field?: string) {
    super(message, 422, true, "GUARD_VALIDATION_ERROR");
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
