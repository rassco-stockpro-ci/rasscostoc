import { db } from "@server/core/config/db";
import {
  courierRequests,
  courierExecutions,
  courierExecutionUnits,
  courierCities,
  courierSimTypes,
  courierVendorTypes,
  courierFailureReasons,
  courierAuditLogs,
  courierPdfReports,
  courierPdfDeletionTasks,
  users,
  employeeProfiles,
  courierRequestItems,
  courierExecutionAttempts,
  itemTypes,
  items,
  inventoryTransactions,
  itemHistoryLogs,
  regions,
  supervisorTechnicians,
  technicianMovingInventoryEntries,
  technicianFixedInventoryEntries,
  inventoryDeductionCompletions,
} from "@shared/schema";
import { eq, and, or, sql, desc, count, inArray, ilike, lt } from "drizzle-orm";
import type { ICourierRepository } from "../../domain/repositories/courier.repository.interface";
import type { ICourierRequestsRepository } from "../../domain/repositories/ICourierRequestsRepository";
import type { ICourierExecutionsRepository } from "../../domain/repositories/ICourierExecutionsRepository";
import type { ICourierPdfRepository, CourierPdfDeletionTask } from "../../domain/repositories/ICourierPdfRepository";
import type { ICourierDashboardReadRepository } from "../../domain/repositories/ICourierDashboardReadRepository";
import type { ICourierInventoryPort } from "../../domain/repositories/ICourierInventoryPort";
import type { CourierExecutionUnit } from "../../domain/courier.types";
import type {
  CourierRequest,
  CourierExecution,
  CourierRequestItem,
  CourierExecutionAttempt,
  CourierPdfReport,
  PdfReportFilters,
  ListFilters,
  ItemUpdatePayload,
  AssignmentUserSnapshot,
  AssignmentRegionSnapshot,
  AssignmentRequestSnapshot,
} from "../../domain/courier.types";
import {
  CourierRequestMapper,
  CourierRequestItemMapper,
  CourierExecutionMapper,
  CourierPdfReportMapper,
  CourierExecutionAttemptMapper
} from "../mappers/courier.mapper";
import {
  buildCourierListConditions,
  courierListExecutionColumns,
  courierListRequestColumns,
} from "../courier-list-query";
import { metrics } from "@core/telemetry/metrics";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";
import { ValidationError, ConflictError, PdfReportAlreadyProcessedError, DuplicateRequestApprovalError } from "@core/errors/AppError";

function toExecutionUnit(row: any, simType: string | null = null): CourierExecutionUnit {
  return {
    id: row.id,
    requestId: row.requestId,
    executionId: row.executionId,
    unitNo: row.unitNo,
    deviceItemId: row.deviceItemId,
    deviceSerial: row.deviceSerial,
    simItemId: row.simItemId ?? null,
    simSerial: row.simSerial ?? null,
    simWaived: row.simWaived,
    tid: row.tid ?? null,
    pairingSource: row.pairingSource,
    simType,
    createdAt: row.createdAt ? new Date(row.createdAt) : null,
  };
}

// An execution row created by importRawRequests from an Excel ticket row (technician name /
// ticket date only) that never recorded any real work. Every condition is required:
//  - written as RECONCILIATION_REQUIRED at insert time: only importRawRequests does that (live
//    paths insert PENDING_DEDUCTION; the backfill script only relabels rows they created);
//  - created by the request's own creator within 60s of the request (same import loop) and never
//    modified since (version 1, updated_at = entered_at);
//  - no device or SIM serial, and not marked "Installation Completed";
//  - no trace of any real work: no execution units, no attempts, no deduction completion, no
//    outbox event, no custody movement, no other applied PDF report, and no audit entry other
//    than a rejected close (verification_failed).
// closingPdfId is the report doing the close: it is already claimed (status "applied") inside the
// same transaction before the takeover runs, so it must not count as "another applied report".
function importPlaceholderCondition(closingPdfId: number) {
  return sql`(
    courier_executions.custody_closure_status = 'RECONCILIATION_REQUIRED'
    AND courier_executions.version = 1
    AND courier_executions.updated_at = courier_executions.entered_at
    AND coalesce(courier_executions.sn, '') = ''
    AND coalesce(courier_executions.sim_serial, '') = ''
    AND courier_executions.installation_status IS DISTINCT FROM 'Installation Completed'
    AND EXISTS (
      SELECT 1 FROM courier_requests r
      WHERE r.id = courier_executions.request_id
        AND r.created_by IS NOT DISTINCT FROM courier_executions.entered_by
        AND abs(extract(epoch FROM (courier_executions.entered_at - r.created_at))) <= 60
    )
    AND NOT EXISTS (SELECT 1 FROM courier_execution_units u
      WHERE u.execution_id = courier_executions.id OR u.request_id = courier_executions.request_id)
    AND NOT EXISTS (SELECT 1 FROM courier_execution_attempts t WHERE t.request_id = courier_executions.request_id)
    AND NOT EXISTS (SELECT 1 FROM inventory_deduction_completions d WHERE d.request_id = courier_executions.request_id)
    AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.payload->>'requestId' = courier_executions.request_id::text)
    AND NOT EXISTS (SELECT 1 FROM custody_movements m
      WHERE m.reference_type = 'COURIER_REQUEST' AND m.reference_id = courier_executions.request_id::text)
    AND NOT EXISTS (SELECT 1 FROM courier_pdf_reports p
      WHERE p.request_id = courier_executions.request_id AND p.status = 'applied' AND p.id <> ${closingPdfId})
    AND NOT EXISTS (SELECT 1 FROM courier_audit_logs a
      WHERE a.table_name IN ('executions', 'courier_executions')
        AND a.record_id = courier_executions.request_id
        AND a.action <> 'verification_failed')
  )`;
}

const BLANK_EXECUTION_FIELDS = {
  requestPriorityLevel: null, pushBack: null, installationStatus: null, paperRoll: null,
  paperRollQty: 0, stickersQty: 0, nulipCardsQty: 0, time: null, deliveryDate: null, responseDate: null,
  sn: null, simSerial: null, simType: null, customerNotes: null, extraField1: null, extraField2: null,
  responseReasonCode: null, salesTechnician: null, technicianCode: null, extractionConfidence: null,
};

export class DrizzleCourierRepository implements
  ICourierRepository,
  ICourierRequestsRepository,
  ICourierExecutionsRepository,
  ICourierPdfRepository,
  ICourierDashboardReadRepository,
  ICourierInventoryPort
{
  constructor(private readonly tx?: any) {}

  private getClient(tx?: any) {
    return tx || this.tx || db;
  }

  // ── Transaction ────────────────────────────────────────────────────────────
  async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return db.transaction(fn);
  }

  // ── Request CRUD ───────────────────────────────────────────────────────────
  async findRequestById(id: number, tx?: any): Promise<CourierRequest | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select()
      .from(courierRequests)
      .where(eq(courierRequests.id, id))
      .limit(1);
    return row ? CourierRequestMapper.toDomain(row) : null;
  }

  async findRequestWithDetails(id: number, tx?: any): Promise<any | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({
        request: courierRequests,
        execution: courierExecutions,
        createdByName: users.fullName,
        createdByAvatar: users.profileImage,
      })
      .from(courierRequests)
      .leftJoin(courierExecutions, eq(courierExecutions.requestId, courierRequests.id))
      .leftJoin(users, eq(users.id, courierRequests.createdBy))
      .where(eq(courierRequests.id, id))
      .limit(1);

    if (!row) return null;
    const items = await this.findRequestItems(id, client);
    return {
      ...CourierRequestMapper.toDomain(row.request),
      created_by_name: row.createdByName,
      created_by_avatar: row.createdByAvatar,
      execution: row.execution
        ? { ...CourierExecutionMapper.toDomain(row.execution), units: await this.findExecutionUnitsByRequestId(id, client) }
        : null,
      items,
    };
  }

  async insertExecutionUnits(units: Omit<CourierExecutionUnit, "id" | "createdAt" | "simType">[], tx?: any): Promise<CourierExecutionUnit[]> {
    if (units.length === 0) return [];
    const client = this.getClient(tx);
    const rows = await client.insert(courierExecutionUnits).values(units).returning();
    return rows.map(toExecutionUnit);
  }

  async findExecutionUnitsByRequestId(requestId: number, tx?: any): Promise<CourierExecutionUnit[]> {
    const client = this.getClient(tx);
    const rows = await client
      .select()
      .from(courierExecutionUnits)
      .where(eq(courierExecutionUnits.requestId, requestId))
      .orderBy(courierExecutionUnits.unitNo);

    // SIM type is not stored on the unit: it is the carrier of the SIM item's type (inventory is the source of truth).
    const simItemIds = rows.map((r: any) => r.simItemId).filter((id: string | null): id is string => !!id);
    const carrierByItem = new Map<string, string | null>();
    if (simItemIds.length > 0) {
      const typeRows = await client
        .select({ itemId: items.id, typeId: itemTypes.id, nameEn: itemTypes.nameEn, nameAr: itemTypes.nameAr })
        .from(items)
        .innerJoin(itemTypes, eq(itemTypes.id, items.itemTypeId))
        .where(inArray(items.id, simItemIds));
      for (const t of typeRows) {
        carrierByItem.set(t.itemId, SerialRecognitionService.resolveCarrierName(t.typeId, t.nameEn ?? "", t.nameAr ?? ""));
      }
    }
    return rows.map((r: any) => toExecutionUnit(r, r.simItemId ? carrierByItem.get(r.simItemId) ?? null : null));
  }

  async findRequestByTid(tid: string, tx?: any): Promise<CourierRequest | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select()
      .from(courierRequests)
      .where(eq(courierRequests.tid, tid))
      .limit(1);
    return row ? CourierRequestMapper.toDomain(row) : null;
  }

  async existsRequestWithTid(tid: string, tx?: any): Promise<boolean> {
    const row = await this.findRequestByTid(tid, tx);
    return row !== null;
  }

  async findExecutionByRequestId(requestId: number, tx?: any): Promise<CourierExecution | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select()
      .from(courierExecutions)
      .where(eq(courierExecutions.requestId, requestId))
      .limit(1);
    return row ? CourierExecutionMapper.toDomain(row) : null;
  }

  async isImportPlaceholderExecution(executionId: number, closingPdfId: number, tx?: any): Promise<boolean> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({ id: courierExecutions.id })
      .from(courierExecutions)
      .where(and(eq(courierExecutions.id, executionId), importPlaceholderCondition(closingPdfId)))
      .limit(1);
    return !!row;
  }

  // The placeholder becomes exactly the row a fresh insert would have produced: every business
  // column is reset, then the real close's data is applied. Its old state is kept by the
  // caller's audit row. Version guard + the same predicate in the WHERE make this the single
  // authoritative decision: a concurrent second close re-evaluates after the first commits and
  // affects zero rows.
  async takeOverImportPlaceholder(
    executionId: number,
    expectedVersion: number,
    closingPdfId: number,
    executionData: any,
    tx?: any,
  ): Promise<CourierExecution | null> {
    const client = this.getClient(tx);
    const mapped = Object.fromEntries(
      Object.entries(CourierExecutionMapper.toPersistence(executionData)).filter(([, v]) => v !== undefined),
    );
    const [row] = await client
      .update(courierExecutions)
      .set({
        ...BLANK_EXECUTION_FIELDS,
        ...mapped,
        custodyClosureStatus: "PENDING_DEDUCTION",
        enteredAt: new Date(),
        updatedAt: new Date(),
        version: sql`version + 1`,
      })
      .where(and(
        eq(courierExecutions.id, executionId),
        eq(courierExecutions.version, expectedVersion),
        importPlaceholderCondition(closingPdfId),
      ))
      .returning();
    return row ? CourierExecutionMapper.toDomain(row) : null;
  }

  async listRequests(filters: ListFilters): Promise<{
    rows: any[];
    total: number;
    meta?: { sqlMs: number; countMs: number; rowsMs: number };
  }> {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const pageSize = filters.pageSize && filters.pageSize > 0 ? filters.pageSize : 50;
    const offset = (page - 1) * pageSize;
    const includeTotal = filters.includeTotal !== false;

    const { whereClause, needsExecutionJoin } = buildCourierListConditions(filters);

    const listSelect = {
      ...courierListRequestColumns,
      executionId: courierListExecutionColumns.id,
      executionRequestId: courierListExecutionColumns.requestId,
      installationStatus: courierListExecutionColumns.installationStatus,
      salesTechnician: courierListExecutionColumns.salesTechnician,
      sn: courierListExecutionColumns.sn,
      simSerial: courierListExecutionColumns.simSerial,
      simType: courierListExecutionColumns.simType,
      deliveryDate: courierListExecutionColumns.deliveryDate,
      responseDate: courierListExecutionColumns.responseDate,
      responseReasonCode: courierListExecutionColumns.responseReasonCode,
      requestPriorityLevel: courierListExecutionColumns.requestPriorityLevel,
      executionTime: courierListExecutionColumns.time,
    };

    const t0 = Date.now();

    const statusPriorityOrder = sql`
      CASE
        WHEN ${courierExecutions.installationStatus} ILIKE '%progress%'
          OR ${courierExecutions.installationStatus} ILIKE '%إجراء%'
          OR ${courierExecutions.installationStatus} ILIKE '%اجراء%' THEN 1
        WHEN ${courierExecutions.id} IS NULL
          OR ${courierExecutions.installationStatus} IS NULL
          OR ${courierExecutions.installationStatus} = ''
          OR ${courierExecutions.installationStatus} ILIKE '%pending%'
          OR ${courierExecutions.installationStatus} ILIKE '%تحقق%' THEN 2
        ELSE 3
      END ASC
    `;

    const orderByClause = (filters.status === "pending" || filters.status === "in_progress")
      ? [statusPriorityOrder, desc(courierRequests.id)]
      : [desc(courierRequests.id)];

    const rowsQuery = db
      .select(listSelect)
      .from(courierRequests)
      .leftJoin(courierExecutions, eq(courierExecutions.requestId, courierRequests.id))
      .where(whereClause)
      .orderBy(...orderByClause)
      .limit(pageSize)
      .offset(offset);

    let countMs = 0;
    let rowsMs = 0;
    let total = 0;
    let rows: Awaited<typeof rowsQuery>;

    if (includeTotal) {
      const countStarted = Date.now();
      const countPromise = needsExecutionJoin
        ? db
            .select({ count: count() })
            .from(courierRequests)
            .leftJoin(courierExecutions, eq(courierExecutions.requestId, courierRequests.id))
            .where(whereClause)
        : db.select({ count: count() }).from(courierRequests).where(whereClause);

      const rowsStarted = Date.now();
      const [totalRes, rowRes] = await Promise.all([countPromise, rowsQuery]);
      countMs = Date.now() - countStarted;
      rowsMs = Date.now() - rowsStarted;
      total = Number(totalRes[0]?.count || 0);
      rows = rowRes;
    } else {
      const rowsStarted = Date.now();
      rows = await rowsQuery;
      rowsMs = Date.now() - rowsStarted;
      total = rows.length;
    }

    const sqlMs = Date.now() - t0;
    metrics.recordValue("courier_list_sql_ms", sqlMs);
    metrics.recordValue("courier_list_count_ms", countMs);
    metrics.recordValue("courier_list_rows_ms", rowsMs);

    return {
      rows: rows.map((r) => ({
        id: r.id,
        date: r.date,
        installationType: r.installationType,
        sim: r.sim,
        tid: r.tid,
        otp: r.otp,
        ticketingHolouly: r.ticketingHolouly,
        incidentNumber: r.incidentNumber,
        pinCode: r.pinCode,
        trsm: r.trsm,
        terminalId: r.terminalId,
        simSn: r.simSn,
        idData: r.idData,
        vendorType: r.vendorType,
        city: r.city,
        cityTec: r.cityTec,
        customerName: r.customerName,
        retailerName: r.retailerName,
        addressAr: r.addressAr,
        addressEn: r.addressEn,
        mobile: r.mobile,
        mobile2: r.mobile2,
        tecName: r.tecName,
        version: r.version,
        execution: r.executionId
          ? {
              id: r.executionId,
              requestId: r.executionRequestId,
              installationStatus: r.installationStatus,
              salesTechnician: r.salesTechnician,
              sn: r.sn,
              simSerial: r.simSerial,
              simType: r.simType,
              deliveryDate: r.deliveryDate,
              responseDate: r.responseDate,
              responseReasonCode: r.responseReasonCode,
              requestPriorityLevel: r.requestPriorityLevel,
              time: r.executionTime,
            }
          : null,
      })),
      total,
      meta: { sqlMs, countMs, rowsMs },
    };
  }

  async listRequestsForExport(filters: ListFilters): Promise<any[]> {
    const { whereClause } = buildCourierListConditions(filters);
    const statusPriorityOrder = sql`
      CASE
        WHEN ${courierExecutions.installationStatus} ILIKE '%progress%'
          OR ${courierExecutions.installationStatus} ILIKE '%إجراء%'
          OR ${courierExecutions.installationStatus} ILIKE '%اجراء%' THEN 1
        WHEN ${courierExecutions.id} IS NULL
          OR ${courierExecutions.installationStatus} IS NULL
          OR ${courierExecutions.installationStatus} = ''
          OR ${courierExecutions.installationStatus} ILIKE '%pending%'
          OR ${courierExecutions.installationStatus} ILIKE '%تحقق%' THEN 2
        ELSE 3
      END ASC
    `;
    const orderByClause = (filters.status === "pending" || filters.status === "in_progress")
      ? [statusPriorityOrder, desc(courierRequests.id)]
      : [desc(courierRequests.id)];

    const rows = await db
      .select({
        request: courierRequests,
        execution: courierExecutions,
      })
      .from(courierRequests)
      .leftJoin(courierExecutions, eq(courierExecutions.requestId, courierRequests.id))
      .where(whereClause)
      .orderBy(...orderByClause);

    return rows.map((r) => ({
      ...CourierRequestMapper.toDomain(r.request),
      execution: r.execution ? CourierExecutionMapper.toDomain(r.execution) : null,
    }));
  }

  async listRequestsForExportPaged(filters: ListFilters, offset: number, limit: number): Promise<any[]> {
    const { whereClause } = buildCourierListConditions(filters);
    const statusPriorityOrder = sql`
      CASE
        WHEN ${courierExecutions.installationStatus} ILIKE '%progress%'
          OR ${courierExecutions.installationStatus} ILIKE '%إجراء%'
          OR ${courierExecutions.installationStatus} ILIKE '%اجراء%' THEN 1
        WHEN ${courierExecutions.id} IS NULL
          OR ${courierExecutions.installationStatus} IS NULL
          OR ${courierExecutions.installationStatus} = ''
          OR ${courierExecutions.installationStatus} ILIKE '%pending%'
          OR ${courierExecutions.installationStatus} ILIKE '%تحقق%' THEN 2
        ELSE 3
      END ASC
    `;
    const orderByClause = (filters.status === "pending" || filters.status === "in_progress")
      ? [statusPriorityOrder, desc(courierRequests.id)]
      : [desc(courierRequests.id)];

    const rows = await db
      .select({
        request: courierRequests,
        execution: courierExecutions,
      })
      .from(courierRequests)
      .leftJoin(courierExecutions, eq(courierExecutions.requestId, courierRequests.id))
      .where(whereClause)
      .orderBy(...orderByClause)
      .offset(offset)
      .limit(limit);

    return rows.map((r) => ({
      ...CourierRequestMapper.toDomain(r.request),
      execution: r.execution ? CourierExecutionMapper.toDomain(r.execution) : null,
    }));
  }

  async countRequests(filters: ListFilters): Promise<number> {
    const { whereClause, needsExecutionJoin } = buildCourierListConditions(filters);
    const countPromise = needsExecutionJoin
      ? db
          .select({ count: count() })
          .from(courierRequests)
          .leftJoin(courierExecutions, eq(courierExecutions.requestId, courierRequests.id))
          .where(whereClause)
      : db.select({ count: count() }).from(courierRequests).where(whereClause);

    const [res] = await countPromise;
    return Number(res?.count || 0);
  }

  async updateRequest(id: number, requestData: any, expectedVersion?: number, tx?: any): Promise<CourierRequest | null> {
    const client = this.getClient(tx);
    let whereClause = eq(courierRequests.id, id);
    if (expectedVersion !== undefined) {
      whereClause = and(whereClause, eq(courierRequests.version, expectedVersion)) as any;
    }

    // OPS-PERM-S0-B1-B.I1: regional ownership is IMMUTABLE-AFTER-CREATE by
    // frozen contract. toPersistence() legitimately accepts regionId for the
    // insert path, so this update path must independently strip it — a
    // client attempting `PUT /requests/:id` with a regionId/region_id field
    // must never be able to reassign ownership through the general update
    // route. Region transfer, if ever authorized, is separate future work
    // with its own dedicated endpoint and audit trail, never this one.
    //
    // The same containment applies to the current field-assignee —
    // PUT /requests/:id is a general request-field update, not an
    // assignment API. The current assignee is immutable through this
    // generic method. Assignment/reassignment must go through a dedicated,
    // authorized operation with its own audit trail, never reachable
    // through this generic update path.
    const {
      regionId: _ignoredRegionId, region_id: _ignoredRegionIdSnake,
      assignedToUserId: _ignoredAssignedToUserId, assigned_to_user_id: _ignoredAssignedToUserIdSnake,
      ...safeRequestData
    } = requestData ?? {};
    const mappedData = CourierRequestMapper.toPersistence(safeRequestData);
    const [row] = await client
      .update(courierRequests)
      .set({
        ...mappedData,
        updatedAt: new Date(),
        version: sql`version + 1`
      })
      .where(whereClause)
      .returning();

    return row ? CourierRequestMapper.toDomain(row) : null;
  }

  async updateExecution(requestId: number, executionData: any, expectedVersion?: number, tx?: any): Promise<CourierExecution | null> {
    const client = this.getClient(tx);
    let whereClause = eq(courierExecutions.requestId, requestId);
    if (expectedVersion !== undefined) {
      whereClause = and(whereClause, eq(courierExecutions.version, expectedVersion)) as any;
    }

    const mappedData = CourierExecutionMapper.toPersistence(executionData);
    const [row] = await client
      .update(courierExecutions)
      .set({
        ...mappedData,
        updatedAt: new Date(),
        version: sql`version + 1`
      })
      .where(whereClause)
      .returning();

    return row ? CourierExecutionMapper.toDomain(row) : null;
  }

  // OPS-PERM-S0-B1-B.I1: the ONLY trusted source of truth for "is this region
  // id real and usable" — an id that merely parses as a string is never
  // sufficient. Enforces regions.is_active so a disabled/retired region can
  // never become a newly-assigned courier_requests.region_id.
  async findActiveRegionById(regionId: string, tx?: any): Promise<{ id: string; name: string } | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({ id: regions.id, name: regions.name })
      .from(regions)
      .where(and(eq(regions.id, regionId), eq(regions.isActive, true)))
      .limit(1);
    return row || null;
  }

  // Locks the actor and target users rows in one
  // deterministically ordered statement (ORDER BY id) so any two concurrent
  // transactions that both need to lock this pair of users rows always
  // request their locks in the same order, regardless of which user is
  // "actor" and which is "target" in either call. FOR SHARE is sufficient
  // here — these rows are read-only prerequisites for this operation (their
  // role/region/active state must not change before commit) and FOR SHARE
  // already blocks UPDATE/DELETE while still permitting unrelated FOR KEY
  // SHARE activity (e.g. FK existence checks from other flows) on the same
  // rows, unlike FOR UPDATE which would conflict with that unnecessarily.
  async lockAssignmentActorAndTarget(
    actorId: string,
    targetId: string,
    tx?: any
  ): Promise<{ actor: AssignmentUserSnapshot | null; target: AssignmentUserSnapshot | null }> {
    const client = this.getClient(tx);
    const rows = await client
      .select({
        id: users.id,
        role: users.role,
        regionId: users.regionId,
        isActive: users.isActive,
      })
      .from(users)
      .where(inArray(users.id, [actorId, targetId]))
      .orderBy(users.id)
      .for("share");

    const byId = new Map<string, AssignmentUserSnapshot>(
      rows.map((row: AssignmentUserSnapshot) => [row.id, row])
    );
    return {
      actor: byId.get(actorId) ?? null,
      target: byId.get(targetId) ?? null,
    };
  }

  // Locks the exact supervisor_technicians relationship row (if one exists)
  // so a concurrent removeTechnicianFromSupervisor DELETE against that same
  // row must wait until this transaction commits or rolls back — the
  // assignment can only ever commit while the relationship it authorized
  // itself against was still valid.
  async lockAssignmentSupervisorTechnicianRelation(
    supervisorId: string,
    technicianId: string,
    tx?: any
  ): Promise<boolean> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({ id: supervisorTechnicians.id })
      .from(supervisorTechnicians)
      .where(
        and(
          eq(supervisorTechnicians.supervisorId, supervisorId),
          eq(supervisorTechnicians.technicianId, technicianId)
        )
      )
      .for("share");
    return !!row;
  }

  // Same FOR SHARE reasoning as lockAssignmentActorAndTarget — a region row
  // is a read-only eligibility prerequisite for this operation, never
  // mutated by it.
  async lockAssignmentRegion(regionId: string, tx?: any): Promise<AssignmentRegionSnapshot | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({ id: regions.id, isActive: regions.isActive })
      .from(regions)
      .where(eq(regions.id, regionId))
      .for("share");
    return row ?? null;
  }

  // Unlike the prerequisite locks above, this row IS mutated by the
  // operation, so FOR UPDATE is used rather than FOR SHARE.
  async lockAssignmentRequest(requestId: number, tx?: any): Promise<AssignmentRequestSnapshot | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({
        id: courierRequests.id,
        regionId: courierRequests.regionId,
        assignedToUserId: courierRequests.assignedToUserId,
        version: courierRequests.version,
      })
      .from(courierRequests)
      .where(eq(courierRequests.id, requestId))
      .for("update");
    return row ?? null;
  }

  // Compare-and-set assignment write. Returns null (no row matched) when the
  // row's version no longer equals expectedVersion at the moment of the
  // write — the caller is responsible for translating that into the
  // OptimisticLockException the client sees. The row is already held under
  // lockAssignmentRequest's FOR UPDATE lock by the time this runs, so this
  // condition should only ever be reached defensively; the version compare
  // still exists to detect a client acting on a stale read, which row
  // locking alone does not express.
  async updateAssignmentWithVersion(
    requestId: number,
    assignedToUserId: string,
    expectedVersion: number,
    tx?: any
  ): Promise<{ version: number } | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .update(courierRequests)
      .set({
        assignedToUserId,
        updatedAt: new Date(),
        version: sql`version + 1`,
      })
      .where(and(eq(courierRequests.id, requestId), eq(courierRequests.version, expectedVersion)))
      .returning({ version: courierRequests.version });
    return row ?? null;
  }

  async insertRequest(requestData: any, tx?: any): Promise<CourierRequest> {
    const client = this.getClient(tx);
    const mappedData = CourierRequestMapper.toPersistence(requestData);
    const [row] = await client
      .insert(courierRequests)
      .values({
        ...mappedData,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();
    return CourierRequestMapper.toDomain(row);
  }

  async insertRequestBulk(requests: any[], tx?: any): Promise<CourierRequest[]> {
    const client = this.getClient(tx);
    if (requests.length === 0) return [];
    const mappedRequests = requests.map(r => ({
      ...CourierRequestMapper.toPersistence(r),
      createdAt: new Date(),
      updatedAt: new Date()
    }));
    const rows = await client
      .insert(courierRequests)
      .values(mappedRequests)
      .returning();
    return rows.map((r: any) => CourierRequestMapper.toDomain(r));
  }

  async insertExecution(executionData: any, tx?: any): Promise<CourierExecution> {
    const client = this.getClient(tx);
    const mappedData = CourierExecutionMapper.toPersistence(executionData);
    try {
      const [row] = await client
        .insert(courierExecutions)
        .values({
          ...mappedData,
          enteredAt: new Date(),
          updatedAt: new Date()
        })
        .returning();
      return CourierExecutionMapper.toDomain(row);
    } catch (err: any) {
      // OPS-REMED-E12: translate ONLY the specific unique-constraint
      // violation on courier_executions.request_id — a different pdf
      // report, approved concurrently for the SAME requestId, already
      // created the execution row first. Any other constraint or error
      // code is NOT this business conflict and must remain a raw
      // technical failure (never misclassified).
      if (err?.code === "23505" && err?.constraint === "courier_executions_request_id_unique") {
        throw new DuplicateRequestApprovalError(mappedData.requestId);
      }
      throw err;
    }
  }

  async deleteRequest(id: number, tx?: any): Promise<boolean> {
    const client = this.getClient(tx);
    const [deleted] = await client
      .delete(courierRequests)
      .where(eq(courierRequests.id, id))
      .returning();
    return !!deleted;
  }

  async deleteAllRequests(tx?: any): Promise<number> {
    const client = this.getClient(tx);
    // 1. Reset any DELIVERED items back to active technician custody (RECEIVED_BY_TECHNICIAN)
    await client
      .update(items)
      .set({ status: "RECEIVED_BY_TECHNICIAN", updatedAt: new Date() })
      .where(eq(items.status, "DELIVERED"));

    // 2. Clear all child courier tables
    await client.delete(courierExecutionAttempts);
    await client.delete(courierExecutions);
    await client.delete(courierRequestItems);
    await client.delete(courierPdfReports);

    // 3. Clear courier requests
    const deletedRows = await client
      .delete(courierRequests)
      .returning({ id: courierRequests.id });
    return deletedRows.length;
  }

  async insertAuditLog(logData: any, tx?: any): Promise<void> {
    const client = this.getClient(tx);
    let actorNameSnapshot = logData.actorNameSnapshot;
    let actorRoleSnapshot = logData.actorRoleSnapshot;
    let actorAvatarUrl = logData.actorAvatarUrl;

    if (logData.changedBy && (!actorNameSnapshot || !actorRoleSnapshot || !actorAvatarUrl)) {
      try {
        const userRow = await client
          .select({
            fullName: users.fullName,
            role: users.role,
            profileImage: users.profileImage,
          })
          .from(users)
          .where(eq(users.id, logData.changedBy))
          .limit(1);

        if (userRow.length > 0) {
          if (!actorNameSnapshot) actorNameSnapshot = userRow[0].fullName;
          if (!actorAvatarUrl) actorAvatarUrl = userRow[0].profileImage;
          if (!actorRoleSnapshot) {
            const empProfile = await client
              .select({ profileData: employeeProfiles.profileData })
              .from(employeeProfiles)
              .where(eq(employeeProfiles.userId, logData.changedBy))
              .limit(1);

            actorRoleSnapshot = empProfile[0]?.profileData?.jobTitle || userRow[0].role || "مشرف العمليات";
          }
        }
      } catch (err) {
        // Fallback silently if user lookup fails
      }
    }

    await client.insert(courierAuditLogs).values({
      tableName: logData.tableName || "requests",
      recordId: Number(logData.recordId || 0),
      fieldName: logData.fieldName || null,
      oldValue: logData.oldValue !== undefined && logData.oldValue !== null ? String(logData.oldValue) : null,
      newValue: logData.newValue !== undefined && logData.newValue !== null ? String(logData.newValue) : null,
      action: logData.action || "update",
      actorNameSnapshot: actorNameSnapshot || null,
      actorRoleSnapshot: actorRoleSnapshot || null,
      actorAvatarUrl: actorAvatarUrl || null,
      actionType: logData.actionType || (logData.action ? String(logData.action).toUpperCase() : "UPDATE"),
      actionDescription: logData.actionDescription || null,
      source: logData.source || "DASHBOARD",
      status: logData.status || "SUCCESS",
      metadata: logData.metadata || null,
      ipAddress: logData.ipAddress || null,
      deviceId: logData.deviceId || null,
      changedBy: logData.changedBy || null,
      changedAt: new Date(),
    });
  }

  async listAuditLogs(limit: number = 100): Promise<any[]> {
    return db
      .select({
        id: courierAuditLogs.id,
        tableName: courierAuditLogs.tableName,
        recordId: courierAuditLogs.recordId,
        action: courierAuditLogs.action,
        fieldName: courierAuditLogs.fieldName,
        oldValue: courierAuditLogs.oldValue,
        newValue: courierAuditLogs.newValue,
        changedBy: users.fullName,
        changedAt: courierAuditLogs.changedAt,
        actorNameSnapshot: courierAuditLogs.actorNameSnapshot,
        actorRoleSnapshot: courierAuditLogs.actorRoleSnapshot,
        actorAvatarUrl: courierAuditLogs.actorAvatarUrl,
        actionType: courierAuditLogs.actionType,
        source: courierAuditLogs.source,
        status: courierAuditLogs.status,
      })
      .from(courierAuditLogs)
      .leftJoin(users, eq(users.id, courierAuditLogs.changedBy))
      .orderBy(desc(courierAuditLogs.changedAt), desc(courierAuditLogs.id))
      .limit(limit);
  }

  async getAuditLogsForRecord(
    recordId: number,
    options: { page?: number; limit?: number } = {},
    tx?: any
  ): Promise<{ rows: any[]; total: number }> {
    const client = this.getClient(tx);
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 10));
    const offset = (page - 1) * limit;

    const whereCond = eq(courierAuditLogs.recordId, recordId);

    const [countResult] = await client
      .select({ count: sql<number>`count(*)::int` })
      .from(courierAuditLogs)
      .where(whereCond);

    const total = countResult?.count || 0;

    const rows = await client
      .select({
        id: courierAuditLogs.id,
        tableName: courierAuditLogs.tableName,
        recordId: courierAuditLogs.recordId,
        action: courierAuditLogs.action,
        actionType: courierAuditLogs.actionType,
        actionDescription: courierAuditLogs.actionDescription,
        fieldName: courierAuditLogs.fieldName,
        oldValue: courierAuditLogs.oldValue,
        newValue: courierAuditLogs.newValue,
        source: courierAuditLogs.source,
        status: courierAuditLogs.status,
        metadata: courierAuditLogs.metadata,
        actorNameSnapshot: courierAuditLogs.actorNameSnapshot,
        actorRoleSnapshot: courierAuditLogs.actorRoleSnapshot,
        actorAvatarUrl: courierAuditLogs.actorAvatarUrl,
        ipAddress: courierAuditLogs.ipAddress,
        deviceId: courierAuditLogs.deviceId,
        changedBy: courierAuditLogs.changedBy,
        changedAt: courierAuditLogs.changedAt,
        userFullName: users.fullName,
        userRole: users.role,
        userProfileImage: users.profileImage,
        employeeCode: users.employeeCode,
        empProfileData: employeeProfiles.profileData,
      })
      .from(courierAuditLogs)
      .leftJoin(users, eq(users.id, courierAuditLogs.changedBy))
      .leftJoin(employeeProfiles, eq(employeeProfiles.userId, courierAuditLogs.changedBy))
      .where(whereCond)
      .orderBy(desc(courierAuditLogs.changedAt), desc(courierAuditLogs.id))
      .limit(limit)
      .offset(offset);

    return { rows, total };
  }

  // OPS-PERM-S0-B1-B.F1.R1: least-privilege technician-directory scoping,
  // enforced in the DATABASE QUERY itself — never by fetching every
  // technician and filtering in application memory. See courier.service.ts
  // getLookups() for the frozen role contract this implements.
  async getLookups(actor: { role: string; regionId: string | null }, tx?: any): Promise<any> {
    const client = this.getClient(tx);
    const cities = await client.select().from(courierCities);
    const simTypes = await client.select().from(courierSimTypes);
    const vendorTypes = await client.select().from(courierVendorTypes);
    const failureReasons = await client.select().from(courierFailureReasons).orderBy(courierFailureReasons.sortOrder);

    let technicians: any[] = [];
    if (actor.role === "admin") {
      technicians = await client
        .select({
          id: users.id,
          username: users.username,
          name: users.fullName,
          technicianCode: users.technicianCode,
          regionId: users.regionId,
        })
        .from(users)
        .where(eq(users.role, "technician"));
    } else if (actor.role === "supervisor") {
      // OPS-PERM-S0-B1-B.F1.R2: missing region ALONE is not the only
      // rejection path — a regionId that is present but points at an
      // INACTIVE (or nonexistent) region must ALSO yield zero technicians.
      // Enforced via a single scoped join (not a separate lookup call plus
      // in-memory filtering): the JOIN condition itself requires
      // regions.is_active = true, so a stale/retired region can never
      // silently satisfy this query no matter what actor.regionId holds.
      if (actor.regionId) {
        technicians = await client
          .select({
            id: users.id,
            username: users.username,
            name: users.fullName,
            technicianCode: users.technicianCode,
            regionId: users.regionId,
          })
          .from(users)
          .innerJoin(regions, eq(regions.id, users.regionId))
          .where(
            and(
              eq(users.role, "technician"),
              eq(users.regionId, actor.regionId),
              eq(regions.id, actor.regionId),
              eq(regions.isActive, true)
            )
          );
      }
    }
    // courier_supervisor / warehouse / technician / viewer: technicians
    // stays [] — no company-wide (or any) technician-directory visibility
    // granted by default for these roles.

    // صفحة courier/pdf الإدارية تحتاج قائمة المناطق لفلترة تقارير البوت/الرفع اليدوي -
    // تُضاف هنا بدل استدعاء /api/regions منفصل، اتساقًا مع نمط "lookups" الحالي
    // OPS-PERM-S0-B1-B.F1.R1: isActive is now selected alongside id/name —
    // purely additive (existing consumers destructuring {id, name} are
    // unaffected); lets NEW region-ownership selectors filter to active-only
    // client-side without a second query or changing this shape for the
    // historical PDF-filter consumer, which still receives every region.
    const regionsList = await client
      .select({ id: regions.id, name: regions.name, isActive: regions.isActive })
      .from(regions);

    return {
      cities,
      simTypes,
      vendorTypes,
      failureReasons,
      regions: regionsList,
      technicians: technicians.map((t: any) => ({
        id: t.id,
        code: t.username,
        name: t.name,
        technicianCode: t.technicianCode,
        regionId: t.regionId,
      }))
    };
  }

  async getDashboardStats(): Promise<{ totalRequests: number; statuses: Record<string, number>; failures: Record<string, number> }> {
    const [totalRes] = await db.select({ count: count() }).from(courierRequests);

    const statusCounts = await db
      .select({ status: courierExecutions.installationStatus, count: count() })
      .from(courierExecutions)
      .groupBy(courierExecutions.installationStatus);

    const failureCounts = await db
      .select({ reason: courierExecutions.responseReasonCode, count: count() })
      .from(courierExecutions)
      .where(sql`${courierExecutions.responseReasonCode} IS NOT NULL`)
      .groupBy(courierExecutions.responseReasonCode);

    return {
      totalRequests: Number(totalRes?.count || 0),
      statuses: statusCounts.reduce((acc: any, curr) => {
        if (curr.status) acc[curr.status] = Number(curr.count);
        return acc;
      }, {}),
      failures: failureCounts.reduce((acc: any, curr) => {
        if (curr.reason) acc[curr.reason] = Number(curr.count);
        return acc;
      }, {})
    };
  }

  async getAiMonitorStats(): Promise<{ totalProcessed: number; totalApplied: number; averageConfidence: number }> {
    const [totalReports] = await db.select({ count: count() }).from(courierPdfReports);
    const [appliedReports] = await db.select({ count: count() }).from(courierPdfReports).where(eq(courierPdfReports.status, "applied"));

    const [avgConf] = await db
      .select({ avg: sql<number>`AVG(overall_confidence)` })
      .from(courierPdfReports)
      .where(sql`overall_confidence IS NOT NULL`);

    return {
      totalProcessed: Number(totalReports?.count || 0),
      totalApplied: Number(appliedReports?.count || 0),
      averageConfidence: avgConf?.avg ? Math.round(Number(avgConf.avg)) : 0
    };
  }

  // ── Request Items ──────────────────────────────────────────────────────────
  async findRequestItems(requestId: number, tx?: any): Promise<CourierRequestItem[]> {
    const client = this.getClient(tx);
    const rows = await client
      .select()
      .from(courierRequestItems)
      .where(eq(courierRequestItems.requestId, requestId));
    return rows.map((r: any) => CourierRequestItemMapper.toDomain(r));
  }

  async findRequestItemBySerial(serial: string, tx?: any): Promise<CourierRequestItem[]> {
    const client = this.getClient(tx);
    const rows = await client
      .select()
      .from(courierRequestItems)
      .where(
        or(
          eq(courierRequestItems.serialNumber, serial),
          eq(courierRequestItems.simSerial, serial)
        )
      );
    return rows.map((r: any) => CourierRequestItemMapper.toDomain(r));
  }

  async findRequestItemById(id: number, tx?: any): Promise<CourierRequestItem | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select()
      .from(courierRequestItems)
      .where(eq(courierRequestItems.id, id))
      .limit(1);
    return row ? CourierRequestItemMapper.toDomain(row) : null;
  }

  async insertRequestItems(items: any[], tx?: any): Promise<CourierRequestItem[]> {
    const client = this.getClient(tx);
    if (items.length === 0) return [];
    const mapped = items.map(i => CourierRequestItemMapper.toPersistence(i));
    const rows = await client
      .insert(courierRequestItems)
      .values(mapped)
      .returning();
    return rows.map((r: any) => CourierRequestItemMapper.toDomain(r));
  }

  async updateRequestItem(id: number, itemData: any, tx?: any): Promise<CourierRequestItem | null> {
    const client = this.getClient(tx);
    const mapped = CourierRequestItemMapper.toPersistence(itemData);
    const [row] = await client
      .update(courierRequestItems)
      .set({ ...mapped, updatedAt: new Date() })
      .where(eq(courierRequestItems.id, id))
      .returning();
    return row ? CourierRequestItemMapper.toDomain(row) : null;
  }

  async deleteRequestItems(requestId: number, tx?: any): Promise<void> {
    const client = this.getClient(tx);
    await client
      .delete(courierRequestItems)
      .where(eq(courierRequestItems.requestId, requestId));
  }

  async findRequestItemsBySerials(serials: string[], statusFilter?: string, tx?: any): Promise<CourierRequestItem[]> {
    const client = this.getClient(tx);
    const serialCondition = or(
      inArray(courierRequestItems.serialNumber, serials),
      inArray(courierRequestItems.simSerial, serials)
    );
    const whereClause = statusFilter
      ? and(serialCondition, eq(courierRequestItems.status, statusFilter))
      : serialCondition;

    const rows = await client
      .select()
      .from(courierRequestItems)
      .where(whereClause);
    return rows.map((r: any) => CourierRequestItemMapper.toDomain(r));
  }

  async bulkUpdateRequestItems(updates: ItemUpdatePayload[], tx?: any): Promise<void> {
    const client = this.getClient(tx);
    for (const u of updates) {
      const { itemId, ...fields } = u;
      const mapped = CourierRequestItemMapper.toPersistence(fields);
      await client
        .update(courierRequestItems)
        .set({ ...mapped, updatedAt: new Date() })
        .where(eq(courierRequestItems.id, itemId));
    }
  }

  // ── Execution Attempts ─────────────────────────────────────────────────────
  async findExecutionAttempts(requestId: number, tx?: any): Promise<CourierExecutionAttempt[]> {
    const client = this.getClient(tx);
    const rows = await client
      .select()
      .from(courierExecutionAttempts)
      .where(eq(courierExecutionAttempts.requestId, requestId))
      .orderBy(desc(courierExecutionAttempts.attemptNumber));
    return rows.map((r: any) => CourierExecutionAttemptMapper.toDomain(r));
  }

  async insertExecutionAttempt(attemptData: any, tx?: any): Promise<CourierExecutionAttempt> {
    const client = this.getClient(tx);
    const mapped = CourierExecutionAttemptMapper.toPersistence(attemptData);
    const [row] = await client
      .insert(courierExecutionAttempts)
      .values({ ...mapped, createdAt: new Date() })
      .returning();
    return CourierExecutionAttemptMapper.toDomain(row);
  }

  // ── PDF Reports ────────────────────────────────────────────────────────────
  // الأعمدة المُثراة (uploaderName/technicianCode/region/matched request) تُبنى بربط
  // uploadedBy بجدول users ثم users.regionId بجدول regions، بالإضافة لربط اختياري
  // بجدول courierRequests لعرض/البحث عن الطلب المطابق - تُستخدم في صفحة courier/pdf
  // الإدارية (فلاتر منطقة/فني + بحث بالجهاز أو الطلب) بدون أي طلب إضافي من الواجهة.
  private pdfReportListColumns() {
    return {
      id: courierPdfReports.id,
      requestId: courierPdfReports.requestId,
      fileName: courierPdfReports.fileName,
      filePath: courierPdfReports.filePath,
      uploadedBy: courierPdfReports.uploadedBy,
      uploadedAt: courierPdfReports.uploadedAt,
      status: courierPdfReports.status,
      ocrText: courierPdfReports.ocrText,
      extractedJson: courierPdfReports.extractedJson,
      overallConfidence: courierPdfReports.overallConfidence,
      uploadedByName: users.fullName,
      uploadedByTechnicianCode: users.technicianCode,
      uploadedByRegionId: users.regionId,
      uploadedByRegionName: regions.name,
      // بيانات الطلب المرتبط - للصفحة الإدارية (بيانات العميل الكاملة)
      requestRetailerName: courierRequests.retailerName,
      requestMobile: courierRequests.mobile,
      requestMobile2: courierRequests.mobile2,
      requestTid: courierRequests.tid,
      requestTerminalId: courierRequests.terminalId,
      requestCustomerName: courierRequests.customerName,
      requestCity: courierRequests.city,
      requestAddressAr: courierRequests.addressAr,
      requestInstallationType: courierRequests.installationType,
      requestVendorType: courierRequests.vendorType,
      requestTecName: courierRequests.tecName,
      requestDate: courierRequests.date,
    };
  }

  async findPdfReportById(id: number, tx?: any): Promise<CourierPdfReport | null> {
    const client = this.getClient(tx);
    const [report] = await client
      .select(this.pdfReportListColumns())
      .from(courierPdfReports)
      .leftJoin(users, eq(courierPdfReports.uploadedBy, users.id))
      .leftJoin(regions, eq(users.regionId, regions.id))
      .leftJoin(courierRequests, eq(courierPdfReports.requestId, courierRequests.id))
      .where(eq(courierPdfReports.id, id))
      .limit(1);
    return report ? CourierPdfReportMapper.toDomain(report) : null;
  }

  async listPdfReports(
    filters?: PdfReportFilters,
    tx?: any,
  ): Promise<CourierPdfReport[]> {
    const client = this.getClient(tx);
    const conditions = [];

    if (filters?.region) {
      conditions.push(eq(users.regionId, filters.region));
    }
    if (filters?.technician) {
      conditions.push(
        or(
          eq(courierPdfReports.uploadedBy, filters.technician),
          eq(users.technicianCode, filters.technician),
        ),
      );
    }
    if (filters?.q) {
      const term = `%${filters.q}%`;
      conditions.push(
        or(
          ilike(courierPdfReports.fileName, term),
          ilike(courierPdfReports.extractedJson, term),
          ilike(courierRequests.retailerName, term),
          ilike(courierRequests.mobile, term),
          ilike(courierRequests.tid, term),
          sql`${courierPdfReports.requestId}::text = ${filters.q}`,
        ),
      );
    }

    let query = client
      .select(this.pdfReportListColumns())
      .from(courierPdfReports)
      .leftJoin(users, eq(courierPdfReports.uploadedBy, users.id))
      .leftJoin(regions, eq(users.regionId, regions.id))
      .leftJoin(courierRequests, eq(courierPdfReports.requestId, courierRequests.id))
      .$dynamic();

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const rows = await query.orderBy(desc(courierPdfReports.id)).limit(100);
    return rows.map((r: any) => CourierPdfReportMapper.toDomain(r));
  }

  async insertPdfReport(data: any, tx?: any): Promise<CourierPdfReport> {
    const filePath = String(data.filePath || data.file_path || "");
    const forbidden = [
      "C:\\", "C:/", "/uploads/", "uploads\\", "uploads/", "/tmp/", "/var/tmp/",
      "file://", "blob:", "base64", "data:application/pdf", "data:image/"
    ];
    for (const pattern of forbidden) {
      if (filePath.toLowerCase().includes(pattern.toLowerCase())) {
        throw new ValidationError(
          `Zero Local Storage Violation: Forbidden local file path, blob, or binary payload detected in filePath: ${filePath}`
        );
      }
    }

    const client = this.getClient(tx);
    const mapped = CourierPdfReportMapper.toPersistence(data);
    const [row] = await client
      .insert(courierPdfReports)
      .values(mapped)
      .returning();
    return CourierPdfReportMapper.toDomain(row);
  }

  async updatePdfReport(id: number, data: any, tx?: any): Promise<CourierPdfReport> {
    const client = this.getClient(tx);
    const mapped = CourierPdfReportMapper.toPersistence(data);
    const [row] = await client
      .update(courierPdfReports)
      .set(mapped)
      .where(eq(courierPdfReports.id, id))
      .returning();
    return CourierPdfReportMapper.toDomain(row);
  }

  /**
   * OPS-REMED-E12 (E1+E2): atomic compare-and-swap transition on
   * pdf_reports.status. No explicit `tx` parameter — relies on `this.tx`
   * bound at construction time by DrizzleCourierUnitOfWork.execute(). The
   * `WHERE ... AND status = $expected` clause makes this a single,
   * indivisible statement at the Postgres row level: of two concurrent
   * callers targeting the same row, exactly one UPDATE affects a row (and
   * returns it) and the other affects zero rows (and gets null) — there is
   * no window in which both can observe the row as eligible.
   */
  async claimPdfReportForTransition(
    pdfId: number,
    expectedStatus: string,
    newStatus: string
  ): Promise<CourierPdfReport | null> {
    const client = this.getClient();
    const [row] = await client
      .update(courierPdfReports)
      .set({ status: newStatus })
      .where(and(eq(courierPdfReports.id, pdfId), eq(courierPdfReports.status, expectedStatus)))
      .returning();
    return row ? CourierPdfReportMapper.toDomain(row) : null;
  }

  /**
   * Row lock for the delete flow (DELETE /api/courier/pdf/:id): `SELECT ...
   * FOR UPDATE` on courier_pdf_reports ONLY (no joins, so no other table's
   * rows are locked) blocks until any concurrent apply/reject CAS on the
   * same id has committed, so delete always sees the post-commit status —
   * never a stale "pending" a moment before it flips to "applied".
   */
  async lockPdfReportById(id: number): Promise<CourierPdfReport | null> {
    const client = this.getClient();
    const [row] = await client
      .select()
      .from(courierPdfReports)
      .where(eq(courierPdfReports.id, id))
      .for("update");
    return row ? CourierPdfReportMapper.toDomain(row) : null;
  }

  /** Hard delete — courier_pdf_reports has no incoming foreign keys. */
  async deletePdfReportRow(id: number): Promise<void> {
    const client = this.getClient();
    await client.delete(courierPdfReports).where(eq(courierPdfReports.id, id));
  }

  async insertPdfDeletionTask(data: {
    reportId: number;
    driveUrl: string | null;
    fileName: string | null;
    requestedBy: string;
  }): Promise<CourierPdfDeletionTask> {
    const client = this.getClient();
    const [row] = await client
      .insert(courierPdfDeletionTasks)
      .values({
        reportId: data.reportId,
        driveUrl: data.driveUrl,
        fileName: data.fileName,
        requestedBy: data.requestedBy,
      })
      .returning();
    return row as unknown as CourierPdfDeletionTask;
  }

  /**
   * Same SELECT ... FOR UPDATE SKIP LOCKED + UPDATE idiom as
   * jobs.repository.ts#claimNextJob — needs its own `db.transaction`
   * (not `this.getClient()`/`this.tx`) because this is called standalone
   * by the bot-facing claim endpoint, never from inside `uow.execute`,
   * and the lock from SKIP LOCKED only holds for the lifetime of one
   * transaction.
   */
  async claimNextPdfDeletionTask(): Promise<CourierPdfDeletionTask | null> {
    return await db.transaction(async (tx) => {
      const [eligible] = await tx
        .select()
        .from(courierPdfDeletionTasks)
        .where(
          and(
            lt(courierPdfDeletionTasks.attempts, 5),
            or(
              eq(courierPdfDeletionTasks.status, "PENDING"),
              and(eq(courierPdfDeletionTasks.status, "CLAIMED"), lt(courierPdfDeletionTasks.leasedUntil, new Date()))
            )
          )
        )
        .orderBy(courierPdfDeletionTasks.id)
        .limit(1)
        .for("update", { skipLocked: true });

      if (!eligible) return null;

      const [row] = await tx
        .update(courierPdfDeletionTasks)
        .set({
          status: "CLAIMED",
          attempts: (eligible as any).attempts + 1,
          leasedUntil: new Date(Date.now() + 5 * 60 * 1000),
        })
        .where(eq(courierPdfDeletionTasks.id, (eligible as any).id))
        .returning();
      return row ? (row as unknown as CourierPdfDeletionTask) : null;
    });
  }

  async completePdfDeletionTask(id: number, success: boolean, error?: string): Promise<CourierPdfDeletionTask | null> {
    const client = this.getClient();
    if (success) {
      const [row] = await client
        .update(courierPdfDeletionTasks)
        .set({ status: "DONE", completedAt: new Date(), lastError: null })
        .where(eq(courierPdfDeletionTasks.id, id))
        .returning();
      return row ? (row as unknown as CourierPdfDeletionTask) : null;
    }

    const [current] = await client
      .select()
      .from(courierPdfDeletionTasks)
      .where(eq(courierPdfDeletionTasks.id, id))
      .limit(1);
    if (!current) return null;

    const nextStatus = (current as any).attempts >= 5 ? "FAILED" : "PENDING";
    const [row] = await client
      .update(courierPdfDeletionTasks)
      .set({ status: nextStatus, lastError: error || null, leasedUntil: null })
      .where(eq(courierPdfDeletionTasks.id, id))
      .returning();
    return row ? (row as unknown as CourierPdfDeletionTask) : null;
  }

  /**
   * OPS-REMED-E4-P2: same CAS idiom as claimPdfReportForTransition — exact
   * positive predecessor-state IN-list, single UPDATE, zero rows on any
   * invalid/duplicate/late transition (never an error).
   */
  async updateCustodyClosureStatus(
    requestId: number,
    fromStates: string[],
    toState: string,
    tx?: any
  ): Promise<CourierExecution | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .update(courierExecutions)
      .set({ custodyClosureStatus: toState })
      .where(
        and(
          eq(courierExecutions.requestId, requestId),
          inArray(courierExecutions.custodyClosureStatus, fromStates)
        )
      )
      .returning();
    return row ? CourierExecutionMapper.toDomain(row) : null;
  }

  // ── Serial Lookup Support ──────────────────────────────────────────────────
  async findItemTypeById(itemTypeId: string, tx?: any): Promise<{ id: string; nameAr: string; nameEn: string; category: string } | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({ id: itemTypes.id, nameAr: itemTypes.nameAr, nameEn: itemTypes.nameEn, category: itemTypes.category })
      .from(itemTypes)
      .where(eq(itemTypes.id, itemTypeId))
      .limit(1);
    return row || null;
  }

  async findUserById(userId: string, tx?: any): Promise<{ id: string; fullName: string; username: string; technicianCode: string | null; role: string; regionId: number | null } | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({ id: users.id, fullName: users.fullName, username: users.username, technicianCode: users.technicianCode, role: users.role, regionId: users.regionId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row || null;
  }

  async findUserByCodeOrUsername(code: string, tx?: any): Promise<{ id: string; fullName: string; username: string; technicianCode: string | null } | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({ id: users.id, fullName: users.fullName, username: users.username, technicianCode: users.technicianCode })
      .from(users)
      .where(
        or(
          eq(users.username, code),
          eq(users.fullName, code),
          eq(users.technicianCode, code)
        )
      )
      .limit(1);
    return row || null;
  }

  async findUserByFuzzyName(name: string, tx?: any): Promise<{ id: string; fullName: string; username: string; technicianCode: string | null } | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({ id: users.id, fullName: users.fullName, username: users.username, technicianCode: users.technicianCode })
      .from(users)
      .where(
        or(
          ilike(users.fullName, `%${name}%`),
          ilike(users.username, `%${name}%`),
          ilike(users.technicianCode, `%${name}%`)
        )
      )
      .limit(1);
    return row || null;
  }

  async findLinkedRequestItemBySerial(serial: string, tx?: any): Promise<{ requestId: number; id: number; itemType: string; status: string } | null> {
    const client = this.getClient(tx);
    const [row] = await client
      .select({
        requestId: courierRequestItems.requestId,
        id: courierRequestItems.id,
        itemType: courierRequestItems.itemType,
        status: courierRequestItems.status,
      })
      .from(courierRequestItems)
      .where(
        or(
          eq(courierRequestItems.serialNumber, serial),
          eq(courierRequestItems.simSerial, serial)
        )
      )
      .limit(1);
    return row || null;
  }

  async searchItemFallbackBySerial(rawSerial: string, tx?: any): Promise<{
    id: string;
    serialNumber: string;
    carrierName: string | null;
    status: string;
    currentOwnerId: string | null;
    technicianName: string | null;
    technicianCode: string | null;
  } | null> {
    // Note: `items` (serialized_items.schema.ts) has no `simSerial` column — SIM
    // ICCIDs are stored in `serialNumber` (see linkSimToTechnician). Matching on
    // serialNumber alone covers both device serials and SIM ICCIDs correctly.
    const client = this.getClient(tx);
    const itemRows = await client
      .select({
        id: items.id,
        serialNumber: items.serialNumber,
        carrierName: items.carrierName,
        status: items.status,
        currentOwnerId: items.currentOwnerId,
        technicianName: users.fullName,
        technicianCode: users.username,
      })
      .from(items)
      .leftJoin(users, eq(users.id, items.currentOwnerId))
      .where(
        or(
          eq(items.serialNumber, rawSerial),
          eq(items.barcode, rawSerial),
          ilike(items.serialNumber, `%${rawSerial}%`)
        )
      )
      .limit(1);

    return itemRows[0] || null;
  }

  async linkSimToTechnician(data: {
    simSerial: string;
    simType?: string;
    technicianId?: string;
    technicianUsername?: string;
    notes?: string;
  }, tx?: any): Promise<{ success: boolean; message: string; item: any }> {
    const client = this.getClient(tx);
    const simSerial = (data.simSerial || "").trim();

    let targetOwnerId = data.technicianId || null;

    if (!targetOwnerId && data.technicianUsername) {
      const uRows = await client
        .select()
        .from(users)
        .where(
          or(
            eq(users.username, data.technicianUsername),
            eq(users.telegramUserId, data.technicianUsername),
            ilike(users.fullName, `%${data.technicianUsername}%`)
          )
        )
        .limit(1);
      if (uRows.length > 0) {
        targetOwnerId = uRows[0].id;
      }
    }

    // Get or create itemType for SIM
    let simTypeId = "";
    const simTypesList = await client
      .select()
      .from(itemTypes)
      .where(or(eq(itemTypes.category, "sim"), ilike(itemTypes.nameAr, "%شريحة%")))
      .limit(1);

    if (simTypesList.length > 0) {
      simTypeId = simTypesList[0].id;
    } else {
      const [newType] = await client.insert(itemTypes).values({
        nameAr: "شريحة اتصال",
        nameEn: "SIM Card",
        category: "sim",
        requiresSerial: true,
      }).returning();
      simTypeId = newType.id;
    }

    // Check if already exists in items
    const existing = await client
      .select()
      .from(items)
      .where(or(eq(items.serialNumber, simSerial), eq(items.barcode, simSerial)))
      .limit(1);

    if (existing.length > 0) {
      // DB-R7 fix: only when this call is actually assigning a new owner
      // (targetOwnerId is set) do we also clear warehouse_id, in the same
      // UPDATE — otherwise an item already sitting in a warehouse would
      // end up with both current_owner_id and warehouse_id set
      // simultaneously (confirmed live in Phase C4.4A). When targetOwnerId
      // is falsy, ownership is left untouched, so warehouse_id must also
      // be left untouched.
      const [updated] = await client
        .update(items)
        .set({
          currentOwnerId: targetOwnerId || existing[0].currentOwnerId,
          warehouseId: targetOwnerId ? null : existing[0].warehouseId,
          carrierName: data.simType || existing[0].carrierName || "STC",
          status: "RECEIVED_BY_TECHNICIAN",
          updatedAt: new Date(),
        })
        .where(eq(items.id, existing[0].id))
        .returning();

      return {
        success: true,
        message: "تم تحديث بيانات الشريحة وربطها بالفني بنجاح",
        item: updated,
      };
    }

    const [newItem] = await client.insert(items).values({
      itemTypeId: simTypeId,
      serialNumber: simSerial,
      barcode: simSerial,
      carrierName: data.simType || "STC",
      currentOwnerId: targetOwnerId,
      status: targetOwnerId ? "RECEIVED_BY_TECHNICIAN" : "WAREHOUSE",
    }).returning();

    return {
      success: true,
      message: "تم إدراج الشريحة في المخزون وربطها بالفني بنجاح",
      item: newItem,
    };
  }

  // ── ICourierInventoryPort ──────────────────────────────────────────────────
  async findItemBySerial(serial: string, tx?: any): Promise<any | null> {
    const client = tx || this.tx || db;
    return SerialRecognitionService.findItemBySerial(serial, client);
  }

  async getTechnicianConsumableBalances(
    technicianId: string,
    itemTypeIds: string[],
    tx?: any
  ): Promise<Record<string, { unitsPerBox: number; buckets: { boxes: number; units: number }[] }>> {
    const client = tx || this.tx || db;
    const result: Record<string, { unitsPerBox: number; buckets: { boxes: number; units: number }[] }> = {};
    if (itemTypeIds.length === 0) return result;

    const types = await client
      .select({ id: itemTypes.id, unitsPerBox: itemTypes.unitsPerBox })
      .from(itemTypes)
      .where(inArray(itemTypes.id, itemTypeIds));
    for (const t of types) result[t.id] = { unitsPerBox: t.unitsPerBox, buckets: [] };

    for (const table of [technicianMovingInventoryEntries, technicianFixedInventoryEntries]) {
      const rows = await client
        .select({ itemTypeId: table.itemTypeId, boxes: table.boxes, units: table.units })
        .from(table)
        .where(and(eq(table.technicianId, technicianId), inArray(table.itemTypeId, itemTypeIds)));
      for (const r of rows) result[r.itemTypeId]?.buckets.push({ boxes: r.boxes, units: r.units });
    }
    return result;
  }

  async hasInventoryDeductionCompletion(requestId: number, tx?: any): Promise<boolean> {
    const client = tx || this.tx || db;
    const [row] = await client
      .select({ id: inventoryDeductionCompletions.id })
      .from(inventoryDeductionCompletions)
      .where(eq(inventoryDeductionCompletions.requestId, requestId))
      .limit(1);
    return !!row;
  }

  async normalizeSerial(serial: string, hintItemTypeId: string, tx?: any): Promise<{
    normalizedSerial: string;
    itemTypeId: string;
    carrierName: string | null;
  }> {
    const client = tx || this.tx || db;
    const result = await SerialRecognitionService.normalizeForStorage(serial, hintItemTypeId, client);
    return {
      normalizedSerial: result.normalizedSerial,
      itemTypeId: result.itemTypeId,
      carrierName: result.carrierName
    };
  }

  async transferCustodyToTechnician(
    params: {
      itemId: string;
      technicianId: string;
      requestId: number;
      oldStatus: string;
      newStatus: "RECEIVED_BY_TECHNICIAN" | "IN_TRANSIT";
    },
    tx?: any
  ): Promise<void> {
    const client = tx || this.tx || db;

    // DB-R9 fix: conditional update guarded by the caller's expected
    // previous status. Previously this UPDATE had no WHERE condition on
    // the item's prior state, so two concurrent callers transferring the
    // same item (e.g. two technicians racing to receive it) could both
    // have their UPDATE succeed and both go on to write a "success"
    // inventory_transactions/item_history_logs row — a lost update with a
    // contradictory audit trail. The caller always fetches and passes
    // oldStatus immediately before calling this method, so requiring the
    // row's current status to still match it turns this into an atomic
    // compare-and-swap: only the request that observes the still-current
    // state can win. A losing concurrent request's UPDATE matches zero
    // rows and is rejected with a ConflictError before any transaction or
    // history record is written for it.
    // DB-R7 fix: assigning a technician as current owner must also clear
    // warehouse_id in the same UPDATE. Without this, an item transferred
    // out of a warehouse (or any item that still carried a warehouseId)
    // would end up with both current_owner_id and warehouse_id set
    // simultaneously — a dual-ownership state confirmed live in Phase
    // C4.4A (no single source of truth for where the physical device is).
    const updateResult = await client
      .update(items)
      .set({
        status: params.newStatus,
        currentOwnerId: params.technicianId,
        warehouseId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(items.id, params.itemId), eq(items.status, params.oldStatus)));

    const updatedRows = (updateResult as any).rowCount ?? (updateResult as any).changes ?? 0;
    if (updatedRows !== 1) {
      throw new ConflictError(
        "تعذر نقل عهدة الصنف: تم تغيير حالته بالفعل بواسطة عملية أخرى (رقم الصنف: " +
          params.itemId +
          ")"
      );
    }

    // Record inventory transaction
    await client.insert(inventoryTransactions).values({
      itemId: params.itemId,
      transactionType: "TRANSFER",
      destinationOwnerId: params.technicianId,
      orderNumber: params.requestId.toString(),
      notes: params.newStatus === "RECEIVED_BY_TECHNICIAN"
        ? `استلام عهدة بالطلب رقم ${params.requestId}`
        : `بدء مهمة التوصيل بالطلب رقم ${params.requestId}`,
    });

    // Record item history log
    await client.insert(itemHistoryLogs).values({
      itemId: params.itemId,
      fromStatus: params.oldStatus,
      toStatus: params.newStatus,
      changedById: params.technicianId,
      notes: params.newStatus === "RECEIVED_BY_TECHNICIAN"
        ? `تحويل عهدة للفني بالمسح الضوئي - طلب رقم ${params.requestId}`
        : `مغادرة المستودع والبدء بالتوصيل - طلب رقم ${params.requestId}`,
    });
  }

  async mintAndAssignToTechnician(
    params: {
      serial: string;
      itemTypeId: string;
      carrierName: string | null;
      technicianId: string;
      requestId: number;
    },
    tx?: any
  ): Promise<{ id: string; serialNumber: string }> {
    const client = tx || this.tx || db;

    // Normalizing/saving a new item in Inventory
    const [newItem] = await client
      .insert(items)
      .values({
        itemTypeId: params.itemTypeId,
        serialNumber: params.serial,
        barcode: params.serial,
        status: "RECEIVED_BY_TECHNICIAN",
        currentOwnerId: params.technicianId,
        warehouseId: null,
        carrierName: params.carrierName,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    if (newItem) {
      // Record inventory transaction
      await client.insert(inventoryTransactions).values({
        itemId: newItem.id,
        transactionType: "INTAKE",
        destinationOwnerId: params.technicianId,
        orderNumber: params.requestId.toString(),
        notes: `تسجيل أصل جديد بالمسح الضوئي - طلب رقم ${params.requestId}`,
      });

      // Record item history log
      await client.insert(itemHistoryLogs).values({
        itemId: newItem.id,
        fromStatus: "NONE",
        toStatus: "RECEIVED_BY_TECHNICIAN",
        changedById: params.technicianId,
        notes: `إنشاء أصل جديد عهدة للفني لأول مرة - طلب رقم ${params.requestId}`,
      });
    }

    return {
      id: newItem.id,
      serialNumber: newItem.serialNumber,
    };
  }
}

export const drizzleCourierRepository = new DrizzleCourierRepository();
