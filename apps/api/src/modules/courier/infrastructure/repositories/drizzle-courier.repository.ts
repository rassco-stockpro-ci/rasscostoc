import { db } from "@server/core/config/db";
import {
  courierRequests,
  courierExecutions,
  courierCities,
  courierSimTypes,
  courierVendorTypes,
  courierFailureReasons,
  courierAuditLogs,
  courierPdfReports,
  users,
  employeeProfiles,
  courierRequestItems,
  courierExecutionAttempts,
  itemTypes,
  items,
  inventoryTransactions,
  itemHistoryLogs,
  regions,
} from "@shared/schema";
import { eq, and, or, sql, desc, count, inArray, ilike } from "drizzle-orm";
import { syncMovingInventory } from "@modules/inventory/contracts/moving-inventory-sync";
import type { ICourierRepository } from "../../domain/repositories/courier.repository.interface";
import type { ICourierRequestsRepository } from "../../domain/repositories/ICourierRequestsRepository";
import type { ICourierExecutionsRepository } from "../../domain/repositories/ICourierExecutionsRepository";
import type { ICourierPdfRepository } from "../../domain/repositories/ICourierPdfRepository";
import type { ICourierDashboardReadRepository } from "../../domain/repositories/ICourierDashboardReadRepository";
import type { ICourierInventoryPort } from "../../domain/repositories/ICourierInventoryPort";
import type {
  CourierRequest,
  CourierExecution,
  CourierRequestItem,
  CourierExecutionAttempt,
  CourierPdfReport,
  PdfReportFilters,
  ListFilters,
  ItemUpdatePayload
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
      execution: row.execution ? CourierExecutionMapper.toDomain(row.execution) : null,
      items,
    };
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

    const mappedData = CourierRequestMapper.toPersistence(requestData);
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
    const [row] = await client
      .insert(courierExecutions)
      .values({
        ...mappedData,
        enteredAt: new Date(),
        updatedAt: new Date()
      })
      .returning();
    return CourierExecutionMapper.toDomain(row);
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

  async getLookups(tx?: any): Promise<any> {
    const client = this.getClient(tx);
    const cities = await client.select().from(courierCities);
    const simTypes = await client.select().from(courierSimTypes);
    const vendorTypes = await client.select().from(courierVendorTypes);
    const failureReasons = await client.select().from(courierFailureReasons).orderBy(courierFailureReasons.sortOrder);

    const technicians = await client
      .select({
        id: users.id,
        username: users.username,
        name: users.fullName,
        technicianCode: users.technicianCode,
        regionId: users.regionId,
      })
      .from(users)
      .where(eq(users.role, "technician"));

    // صفحة courier/pdf الإدارية تحتاج قائمة المناطق لفلترة تقارير البوت/الرفع اليدوي -
    // تُضاف هنا بدل استدعاء /api/regions منفصل، اتساقًا مع نمط "lookups" الحالي
    const regionsList = await client.select({ id: regions.id, name: regions.name }).from(regions);

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

  // ── ICourierInventoryPort ──────────────────────────────────────────────────
  async findItemBySerial(serial: string, tx?: any): Promise<any | null> {
    const client = tx || this.tx || db;
    return SerialRecognitionService.findItemBySerial(serial, client);
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

    // Update item status & current owner
    await client
      .update(items)
      .set({
        status: params.newStatus,
        currentOwnerId: params.technicianId,
        updatedAt: new Date(),
      })
      .where(eq(items.id, params.itemId));

    // Moving-inventory counter: only a genuine custody GAIN (item wasn't
    // already technician-held) should increment it. A same-technician
    // status move (e.g. RECEIVED_BY_TECHNICIAN -> IN_TRANSIT while starting
    // the delivery task) must not double-count — this was the exact gap
    // that left technician/item-type pairs with real items but no counter
    // row at all.
    const TECHNICIAN_HELD_STATUSES = ["IN_TRANSIT_CUSTODY", "RECEIVED_BY_TECHNICIAN", "IN_TRANSIT"];
    if (!TECHNICIAN_HELD_STATUSES.includes(params.oldStatus)) {
      const [itemRow] = await client
        .select({ itemTypeId: items.itemTypeId })
        .from(items)
        .where(eq(items.id, params.itemId));
      if (itemRow) {
        await syncMovingInventory(client, params.technicianId, itemRow.itemTypeId, 1);
      }
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

      // Brand-new item minted straight into technician custody — always a
      // genuine gain, unconditionally sync the moving-inventory counter.
      await syncMovingInventory(client, params.technicianId, params.itemTypeId, 1);
    }

    return {
      id: newItem.id,
      serialNumber: newItem.serialNumber,
    };
  }
}

export const drizzleCourierRepository = new DrizzleCourierRepository();
