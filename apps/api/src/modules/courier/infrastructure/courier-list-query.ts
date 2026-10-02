/**
 * ERP-001 Package A — Smart Search + list filter builder for Courier requests.
 * Replaces leading-wildcard LIKE '%q%' with exact / prefix / normalized predicates.
 */

import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { courierExecutionUnits, courierExecutions, courierRequests } from "@shared/schema";
import type { ListFilters } from "../domain/courier.types";

/** Normalize user input: trim, collapse whitespace. */
export function normalizeSearchQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Digits-only form for mobile / numeric TID variants. */
export function normalizeDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * True when the query looks like an identifier (TID, serial, incident, mobile)
 * rather than a free-text customer name.
 */
export function isIdentifierQuery(q: string): boolean {
  if (q.length < 3) return false;
  if (/\s/.test(q)) return false;
  return /^[A-Za-z0-9_\-/]+$/.test(q);
}

/**
 * Build OR conditions for list search without leading-wildcard LIKE.
 * Identifier path prefers equality + prefix (`q%`) — requires text_pattern_ops
 * indexes (migration 0019) for Index Scan on LIKE 'prefix%'.
 *
 * For identifiers, match request-side columns OR execution-side via id IN
 * (indexable subqueries) instead of a single cross-table OR Filter that
 * forces Seq Scan + Hash Join.
 */
export function buildSmartSearchCondition(rawQ: string): SQL | undefined {
  const q = normalizeSearchQuery(rawQ);
  if (!q) return undefined;

  const prefix = `${q}%`;
  const digits = normalizeDigits(q);

  if (isIdentifierQuery(q)) {
    const requestSide = or(
      eq(courierRequests.tid, q),
      eq(courierRequests.terminalId, q),
      eq(courierRequests.incidentNumber, q),
      eq(courierRequests.mobile, q),
      eq(courierRequests.ticketingHolouly, q),
      eq(courierRequests.simSn, q),
      eq(courierRequests.pinCode, q),
      eq(courierRequests.trsm, q),
      sql`${courierRequests.id}::text = ${q}`,
      sql`${courierRequests.tid} LIKE ${prefix}`,
      sql`${courierRequests.terminalId} LIKE ${prefix}`,
      sql`${courierRequests.incidentNumber} LIKE ${prefix}`,
      sql`${courierRequests.mobile} LIKE ${prefix}`,
      sql`${courierRequests.ticketingHolouly} LIKE ${prefix}`,
      sql`${courierRequests.simSn} LIKE ${prefix}`,
      sql`${courierRequests.id}::text LIKE ${prefix}`,
      ...(digits.length >= 6 && digits !== q
        ? [
            eq(courierRequests.mobile, digits),
            eq(courierRequests.tid, digits),
            sql`${courierRequests.mobile} LIKE ${digits + "%"}`,
            sql`${courierRequests.tid} LIKE ${digits + "%"}`,
          ]
        : [])
    );

    // Execution SN/SIM via indexed subquery — keeps planner on Index Scan paths
    const executionHit = sql`${courierRequests.id} IN (
      SELECT ${courierExecutions.requestId} FROM ${courierExecutions}
      WHERE ${courierExecutions.sn} = ${q}
         OR ${courierExecutions.simSerial} = ${q}
         OR ${courierExecutions.sn} LIKE ${prefix}
         OR ${courierExecutions.simSerial} LIKE ${prefix}
    )`;

    // A close installs N units: every device and SIM of every unit is searchable, not only the first.
    const unitHit = sql`${courierRequests.id} IN (
      SELECT ${courierExecutionUnits.requestId} FROM ${courierExecutionUnits}
      WHERE ${courierExecutionUnits.deviceSerial} = ${q}
         OR ${courierExecutionUnits.simSerial} = ${q}
         OR ${courierExecutionUnits.deviceSerial} LIKE ${prefix}
         OR ${courierExecutionUnits.simSerial} LIKE ${prefix}
    )`;

    return or(requestSide!, executionHit, unitHit);
  }

  // Free-text / name: prefix match only (no leading %)
  return or(
    sql`${courierRequests.customerName} LIKE ${prefix}`,
    sql`${courierRequests.tecName} LIKE ${prefix}`,
    sql`${courierRequests.retailerName} LIKE ${prefix}`,
    sql`${courierRequests.tid} LIKE ${prefix}`,
    sql`${courierRequests.terminalId} LIKE ${prefix}`,
    sql`${courierRequests.incidentNumber} LIKE ${prefix}`,
    sql`${courierRequests.mobile} LIKE ${prefix}`,
    sql`${courierRequests.ticketingHolouly} LIKE ${prefix}`,
    sql`${courierRequests.id}::text LIKE ${prefix}`,
    sql`${courierRequests.id} IN (
      SELECT ${courierExecutions.requestId} FROM ${courierExecutions}
      WHERE ${courierExecutions.sn} LIKE ${prefix}
         OR ${courierExecutions.simSerial} LIKE ${prefix}
         OR ${courierExecutions.salesTechnician} LIKE ${prefix}
    )`,
    sql`${courierRequests.id} IN (
      SELECT ${courierExecutionUnits.requestId} FROM ${courierExecutionUnits}
      WHERE ${courierExecutionUnits.deviceSerial} LIKE ${prefix}
         OR ${courierExecutionUnits.simSerial} LIKE ${prefix}
    )`
  );
}

/** Filters that require joining courier_executions in FROM for WHERE correctness. */
export function listFiltersNeedExecutionJoin(filters: ListFilters): boolean {
  // Smart search uses IN (SELECT ...) for execution fields — no outer JOIN required.
  return !!(filters.technician || filters.status || filters.reason || filters.simType || filters.priority);
}

export function buildCourierListConditions(filters: ListFilters): {
  whereClause: SQL | undefined;
  needsExecutionJoin: boolean;
} {
  const conditions: SQL[] = [];
  const needsExecutionJoin = listFiltersNeedExecutionJoin(filters);

  if (filters.q) {
    const search = buildSmartSearchCondition(filters.q);
    if (search) conditions.push(search);
  }
  if (filters.city) {
    conditions.push(eq(courierRequests.city, filters.city));
  }
  if (filters.technician) {
    conditions.push(eq(courierExecutions.salesTechnician, filters.technician));
  }
  if (filters.status) {
    if (filters.status === "pending" || filters.status === "in_progress") {
      // جديد (بانتظار التحقق) وتحت الإجراء: لا يوجد سجل execution أو الحالة فارغة أو In Progress أو pending أو تحوي أيا من مرادفات تحت الإجراء/تحقق
      conditions.push(
        or(
          sql`${courierExecutions.id} IS NULL`,
          sql`${courierExecutions.installationStatus} IS NULL`,
          sql`${courierExecutions.installationStatus} = ''`,
          sql`${courierExecutions.installationStatus} ILIKE ${"%progress%"}`,
          sql`${courierExecutions.installationStatus} ILIKE ${"%pending%"}`,
          sql`${courierExecutions.installationStatus} ILIKE ${"%processing%"}`,
          sql`${courierExecutions.installationStatus} ILIKE ${"%تحقق%"}`,
          sql`${courierExecutions.installationStatus} ILIKE ${"%إجراء%"}`,
          sql`${courierExecutions.installationStatus} ILIKE ${"%اجراء%"}`
        )!
      );
    } else if (filters.status === "completed") {
      // مكتمل: أي حالة تحمل "Completed"
      conditions.push(
        or(
          eq(courierExecutions.installationStatus, "Installation Completed"),
          eq(courierExecutions.installationStatus, "Installation Completed - NL"),
          sql`${courierExecutions.installationStatus} LIKE ${"Installation Completed%"}`
        )!
      );
    } else if (filters.status === "not_completed") {
      // غير مكتمل: يوجد execution لكن الحالة ليست completed وليست تحت الإجراء/جديد
      conditions.push(
        and(
          sql`${courierExecutions.id} IS NOT NULL`,
          sql`${courierExecutions.installationStatus} IS NOT NULL`,
          sql`${courierExecutions.installationStatus} <> ''`,
          sql`${courierExecutions.installationStatus} NOT LIKE ${"Installation Completed%"}`,
          sql`${courierExecutions.installationStatus} NOT ILIKE ${"%progress%"}`,
          sql`${courierExecutions.installationStatus} NOT ILIKE ${"%pending%"}`,
          sql`${courierExecutions.installationStatus} NOT ILIKE ${"%processing%"}`,
          sql`${courierExecutions.installationStatus} NOT ILIKE ${"%تحقق%"}`,
          sql`${courierExecutions.installationStatus} NOT ILIKE ${"%إجراء%"}`,
          sql`${courierExecutions.installationStatus} NOT ILIKE ${"%اجراء%"}`
        )!
      );
    } else if (filters.status === "Installation Completed") {
      conditions.push(
        or(
          eq(courierExecutions.installationStatus, "Installation Completed"),
          eq(courierExecutions.installationStatus, "Installation Completed - NL")
        )!
      );
    } else {
      conditions.push(eq(courierExecutions.installationStatus, filters.status));
    }
  }
  if (filters.reason) {
    conditions.push(eq(courierExecutions.responseReasonCode, filters.reason));
  }
  if (filters.simType) {
    conditions.push(eq(courierExecutions.simType, filters.simType));
  }
  if (filters.vendor) {
    conditions.push(eq(courierRequests.vendorType, filters.vendor));
  }
  if (filters.priority) {
    conditions.push(eq(courierExecutions.requestPriorityLevel, filters.priority));
  }
  if (filters.dateFrom) {
    conditions.push(sql`${courierRequests.date} >= ${filters.dateFrom}`);
  }
  if (filters.dateTo) {
    conditions.push(sql`${courierRequests.date} <= ${filters.dateTo}`);
  }

  return {
    whereClause: conditions.length > 0 ? and(...conditions) : undefined,
    needsExecutionJoin,
  };
}

/** List DTO column projection — fields needed by Verification / Raw Data / Reports. */
export const courierListRequestColumns = {
  id: courierRequests.id,
  date: courierRequests.date,
  installationType: courierRequests.installationType,
  sim: courierRequests.sim,
  tid: courierRequests.tid,
  otp: courierRequests.otp,
  ticketingHolouly: courierRequests.ticketingHolouly,
  incidentNumber: courierRequests.incidentNumber,
  pinCode: courierRequests.pinCode,
  trsm: courierRequests.trsm,
  terminalId: courierRequests.terminalId,
  simSn: courierRequests.simSn,
  idData: courierRequests.idData,
  vendorType: courierRequests.vendorType,
  city: courierRequests.city,
  cityTec: courierRequests.cityTec,
  customerName: courierRequests.customerName,
  retailerName: courierRequests.retailerName,
  addressAr: courierRequests.addressAr,
  addressEn: courierRequests.addressEn,
  mobile: courierRequests.mobile,
  mobile2: courierRequests.mobile2,
  tecName: courierRequests.tecName,
  version: courierRequests.version,
} as const;

export const courierListExecutionColumns = {
  id: courierExecutions.id,
  requestId: courierExecutions.requestId,
  installationStatus: courierExecutions.installationStatus,
  salesTechnician: courierExecutions.salesTechnician,
  sn: courierExecutions.sn,
  simSerial: courierExecutions.simSerial,
  simType: courierExecutions.simType,
  deliveryDate: courierExecutions.deliveryDate,
  responseDate: courierExecutions.responseDate,
  responseReasonCode: courierExecutions.responseReasonCode,
  requestPriorityLevel: courierExecutions.requestPriorityLevel,
  time: courierExecutions.time,
} as const;
