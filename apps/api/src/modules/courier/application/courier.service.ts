import fs from "fs";
import path from "path";
import { db } from "@server/core/config/db";
import { items, users, courierExecutions, courierRequests } from "@shared/schema";
import { eq, or, ilike } from "drizzle-orm";
import type { ListFilters, CourierRequestItem, CourierExecutionAttempt } from "../domain/courier.types";
import { devicesContainer } from "@server/composition/devices.container";
import { extractFromPdf } from "./ocr.helper";
import {
  buildCompleteExecutionPayload,
  buildExtractedPayloadFromOcr,
  ensureDevicesInExtractedJson,
  runAiEngineExtraction,
  type CompleteDeviceInput,
} from "./ai-engine/courier-pdf-extraction.adapter";
import { parseRawDataWorkbook, buildExportWorkbook } from "./excel.helper";
import { CompletionGuard, isCompletedStatus } from "./guards/CompletionGuard";
import { normalizeSerialList } from "./guards/guard.types";
import { metrics } from "@core/telemetry/metrics";
import { CourierWorkflow } from "./workflow/courier.workflow";
import { EventBus } from "@core/events/event-bus";
import { ExecutionSavedEvent, ExecutionCompletedEvent } from "@core/events/events";
import { AppError, OptimisticLockException, NotFoundError } from "@core/errors/AppError";
import { AuditLogFormatter, type AuditLogDto } from "./audit-log-formatter";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";
import { resolveSimItemTypeCandidates } from "./sim-item-type-resolver";
import type { ICourierRequestsRepository } from "../domain/repositories/ICourierRequestsRepository";
import type { ICourierExecutionsRepository } from "../domain/repositories/ICourierExecutionsRepository";
import type { ICourierPdfRepository } from "../domain/repositories/ICourierPdfRepository";
import type { ICourierDashboardReadRepository } from "../domain/repositories/ICourierDashboardReadRepository";
import type { ICourierInventoryPort } from "../domain/repositories/ICourierInventoryPort";
import type { ICourierUnitOfWork } from "../domain/repositories/ICourierUnitOfWork";

const ACTIVE_CUSTODY_STATUSES = [
  "IN_TRANSIT_CUSTODY",
  "RECEIVED_BY_TECHNICIAN",
  "IN_TRANSIT",
] as const;

// Re-export for backwards compatibility with any existing consumers
export type { ListFilters } from "../domain/courier.types";

export class CourierService {
  constructor(
    private readonly uow: ICourierUnitOfWork,
    private readonly requestsRepo: ICourierRequestsRepository,
    private readonly executionsRepo: ICourierExecutionsRepository,
    private readonly pdfRepo: ICourierPdfRepository,
    private readonly dashboardRepo: ICourierDashboardReadRepository,
    private readonly inventoryPort: ICourierInventoryPort
  ) {}

  /**
   * Keep only columns that may be written from the portal/Flutter execution form.
   * Strips id/requestId/enteredAt/updatedAt/version and any unknown keys.
   */
  static sanitizeExecutionPayload(data: Record<string, any> = {}): Record<string, any> {
    const allowed = [
      "requestPriorityLevel",
      "pushBack",
      "installationStatus",
      "paperRoll",
      "paperRollQty",
      "stickersQty",
      "nulipCardsQty",
      "time",
      "deliveryDate",
      "responseDate",
      "sn",
      "simSerial",
      "simType",
      "customerNotes",
      "extraField1",
      "extraField2",
      "responseReasonCode",
      "salesTechnician",
      "technicianCode",
      "extractionConfidence",
    ] as const;

    const out: Record<string, any> = {};
    for (const key of allowed) {
      if (data[key] !== undefined) out[key] = data[key];
    }
    return out;
  }

  async listRequests(filters: ListFilters): Promise<{
    rows: any[];
    total: number;
    meta?: { sqlMs: number; countMs: number; rowsMs: number };
  }> {
    const t0 = Date.now();
    const result = await this.requestsRepo.listRequests(filters);
    metrics.recordValue("courier_list_api_ms", Date.now() - t0);
    return result;
  }

  async getRequestById(id: number): Promise<any | null> {
    return this.requestsRepo.findRequestWithDetails(id);
  }

  async createRequest(data: any, createdBy: string): Promise<any> {
    const newReq = await this.requestsRepo.insertRequest({
      ...data,
      createdBy
    });

    await this.dashboardRepo.insertAuditLog({
      tableName: "requests",
      recordId: newReq.id,
      action: "create",
      changedBy: createdBy
    });

    return this.getRequestById(newReq.id);
  }

  async updateRequest(id: number, data: any, updatedBy: string): Promise<any> {
    const { version, ...updateFields } = data;

    const updatedReq = await this.requestsRepo.updateRequest(id, updateFields, version);

    if (!updatedReq) {
      const exists = await this.requestsRepo.findRequestById(id);
      if (exists) {
        throw new OptimisticLockException("courier_requests", id, version, exists.version);
      }
      return null;
    }

    await this.dashboardRepo.insertAuditLog({
      tableName: "requests",
      recordId: id,
      action: "update",
      changedBy: updatedBy
    });

    return this.getRequestById(id);
  }

  async deleteRequest(id: number, deletedBy: string): Promise<boolean> {
    const success = await this.requestsRepo.deleteRequest(id);
    if (!success) return false;

    await this.dashboardRepo.insertAuditLog({
      tableName: "requests",
      recordId: id,
      action: "delete",
      changedBy: deletedBy
    });

    return true;
  }

  async deleteAllRequests(deletedBy: string): Promise<number> {
    const count = await this.requestsRepo.deleteAllRequests();

    await this.dashboardRepo.insertAuditLog({
      tableName: "requests",
      recordId: 0,
      action: "delete_all",
      fieldName: "all_requests",
      oldValue: String(count),
      newValue: "0",
      changedBy: deletedBy
    });

    return count;
  }

  async getRequestAuditLogs(
    requestId: number,
    options: { page?: number; limit?: number } = {},
    requestingUser?: any
  ): Promise<{
    items: AuditLogDto[];
    total: number;
    page: number;
    limit: number;
    latestUpdate: AuditLogDto | null;
  }> {
    const allowSensitive =
      requestingUser?.role === "admin" ||
      requestingUser?.role === "supervisor" ||
      (Array.isArray(requestingUser?.permissions) && requestingUser.permissions.includes("audit:sensitive"));

    const { rows, total } = await (this.requestsRepo as any).getAuditLogsForRecord(requestId, options);

    const items = rows.map((row: any) => AuditLogFormatter.format(row, { allowSensitive }));
    const latestUpdate = items.length > 0 && (options.page || 1) === 1 ? items[0] : null;

    return {
      items,
      total,
      page: Math.max(1, options.page || 1),
      limit: Math.min(100, Math.max(1, options.limit || 10)),
      latestUpdate,
    };
  }

  async getRequestItems(requestId: number): Promise<CourierRequestItem[]> {
    return this.requestsRepo.findRequestItems(requestId);
  }

  async assignRequestItems(
    requestId: number,
    itemsData: { itemType: string; serialNumber?: string; simSerial?: string; quantity?: number }[],
    actorId: string
  ): Promise<CourierRequestItem[]> {
    const request = await this.requestsRepo.findRequestById(requestId);
    if (!request) {
      throw new Error("الطلب غير موجود");
    }

    const newItems = itemsData.map(item => ({
      requestId,
      itemType: item.itemType,
      serialNumber: item.serialNumber || null,
      simSerial: item.simSerial || null,
      quantity: item.quantity ?? 1,
      status: "PENDING_RECEIPT",
    }));

    let result: CourierRequestItem[];
    await this.uow.execute(async (ctx) => {
      // 1. Delete existing items for this request to override/assign fresh
      await ctx.requestsRepository.deleteRequestItems(requestId);

      // 2. Insert new request items
      result = await ctx.requestsRepository.insertRequestItems(newItems);

      // 3. Create or update execution status to ASSIGNED
      const existingExecution = await ctx.executionsRepository.findExecutionByRequestId(requestId);
      if (existingExecution) {
        await ctx.executionsRepository.updateExecution(
          requestId,
          { installationStatus: "ASSIGNED", enteredBy: actorId },
          existingExecution.version
        );
      } else {
        await ctx.executionsRepository.insertExecution({
          requestId,
          installationStatus: "ASSIGNED",
          enteredBy: actorId,
        });
      }

      // Log Audit
      await ctx.dashboardRepository.insertAuditLog({
        tableName: "courier_request_items",
        recordId: requestId,
        action: "assign",
        changedBy: actorId,
      });
    });

    return result!;
  }

  async acceptRequest(requestId: number, actorId: string): Promise<any> {
    const existingExecution = await this.executionsRepo.findExecutionByRequestId(requestId);
    await this.uow.execute(async (ctx) => {
      if (existingExecution) {
        await ctx.executionsRepository.updateExecution(
          requestId,
          { installationStatus: "ACCEPTED", enteredBy: actorId },
          existingExecution.version
        );
      } else {
        await ctx.executionsRepository.insertExecution({
          requestId,
          installationStatus: "ACCEPTED",
          enteredBy: actorId,
        });
      }

      // Auto-create request items if none exist yet (V14 Quantity-only flow)
      const existingItems = await ctx.requestsRepository.findRequestItems(requestId);
      if (existingItems.length === 0) {
        const request = await ctx.requestsRepository.findRequestById(requestId);
        if (request) {
          const itemsToCreate: any[] = [];

          // Infer POS count from installationType (e.g. "POS x2" or default 1)
          const posMatch = String(request.installationType || '').match(/(\d+)/);
          const posCount = posMatch ? parseInt(posMatch[1]) : 1;
          for (let i = 0; i < posCount; i++) {
            itemsToCreate.push({
              requestId,
              itemType: 'POS',
              quantity: 1,
              status: 'PENDING_RECEIPT',
            });
          }

          // Infer SIM count from sim field
          if (request.sim && String(request.sim).trim().length > 0) {
            const simMatch = String(request.sim).match(/(\d+)/);
            const simCount = simMatch ? Math.min(parseInt(simMatch[1]), 10) : 1;
            for (let i = 0; i < simCount; i++) {
              itemsToCreate.push({
                requestId,
                itemType: 'SIM',
                quantity: 1,
                status: 'PENDING_RECEIPT',
              });
            }
          } else {
            // Default: 1 SIM per POS
            for (let i = 0; i < posCount; i++) {
              itemsToCreate.push({
                requestId,
                itemType: 'SIM',
                quantity: 1,
                status: 'PENDING_RECEIPT',
              });
            }
          }

          if (itemsToCreate.length > 0) {
            await ctx.requestsRepository.insertRequestItems(itemsToCreate);
            console.log(`[AcceptRequest] Auto-created ${itemsToCreate.length} request items for request ${requestId}`);
          }
        }
      }

      await ctx.dashboardRepository.insertAuditLog({
        tableName: "requests",
        recordId: requestId,
        action: "accept",
        changedBy: actorId,
      });
    });

    return this.getRequestById(requestId);
  }

  async scanRequestItem(
    requestId: number,
    serial: string,
    actorId: string
  ): Promise<{ success: boolean; message: string; item?: CourierRequestItem }> {
    const candidates = await SerialRecognitionService.buildStoredSerialCandidates(serial);
    if (candidates.length === 0) {
      return { success: false, message: "الرقم التسلسلي فارغ بعد التنظيف" };
    }
    const matchesSerial = (item: CourierRequestItem) => {
      const sn = (item.serialNumber || "").toUpperCase();
      const sim = (item.simSerial || "").toUpperCase();
      return (
        candidates.includes(sn) ||
        candidates.includes(sim) ||
        item.serialNumber === serial ||
        item.simSerial === serial
      );
    };

    // 1. Search inside request items for PENDING_RECEIPT item
    const requestItems = await this.requestsRepo.findRequestItems(requestId);
    
    // Find matching item (by serialNumber or simSerial — any equivalent form)
    const matchingItem = requestItems.find(
      item => item.status === "PENDING_RECEIPT" && matchesSerial(item)
    );

    if (matchingItem) {
      // Update item to RECEIVED
      const updated = await this.requestsRepo.updateRequestItem(matchingItem.id, {
        status: "RECEIVED",
        scannedAt: new Date(),
        receivedAt: new Date(),
        technicianId: actorId,
      });

      // Update execution status to RECEIVING if not already there
      const execution = await this.executionsRepo.findExecutionByRequestId(requestId);
      if (execution && execution.installationStatus !== "RECEIVING") {
        await this.executionsRepo.updateExecution(
          requestId,
          { installationStatus: "RECEIVING" },
          execution.version
        );
      }

      return {
        success: true,
        message: "تم استلام ومطابقة الجهاز بنجاح",
        item: updated || undefined,
      };
    }

    // 2. Check if already scanned in this request
    const alreadyScanned = requestItems.find(
      item => item.status === "RECEIVED" && matchesSerial(item)
    );
    if (alreadyScanned) {
      return {
        success: true,
        message: "تم استلام هذا الجهاز مسبقاً",
        item: alreadyScanned,
      };
    }

    // 3. Check if assigned to another active request
    const otherRequestItems = await this.requestsRepo.findRequestItemsBySerials(candidates, "PENDING_RECEIPT");

    if (otherRequestItems.length > 0) {
      return {
        success: false,
        message: `الجهاز مرتبط بطلب آخر (Request #${otherRequestItems[0].requestId})`,
      };
    }

    return {
      success: false,
      message: "هذا الجهاز غير مخصص لهذا الطلب",
    };
  }

  async confirmReceiving(
    requestId: number,
    actorId: string,
    itemStatuses?: { itemId: number; status: string; serialNumber?: string; simSerial?: string }[],
    sessionMetadata?: any
  ): Promise<any> {
    const requestItems = await this.requestsRepo.findRequestItems(requestId);
    if (requestItems.length === 0) {
      throw new Error("لا توجد عناصر مخصصة لهذا الطلب");
    }

    await this.uow.execute(async (ctx) => {
      // 1. Update items in itemStatuses if provided (for progressive receiving)
      if (itemStatuses && itemStatuses.length > 0) {
        // Validate uniqueness of serial numbers in the input list
        const serialsList = itemStatuses
          .map(i => (i.serialNumber || i.simSerial || "").trim())
          .filter(s => s.length > 0);
        const uniqueSerials = new Set(serialsList);
        if (uniqueSerials.size !== serialsList.length) {
          throw new AppError("توجد أرقام تسلسلية مكررة في قائمة التوريد", 400);
        }

        // Also check if any of these serials are already used in this request or another request
        for (const itemStat of itemStatuses) {
          const serial = (itemStat.serialNumber || itemStat.simSerial || "").trim();
          if (serial.length > 0) {
            const alreadyAssigned = await ctx.requestsRepository.findRequestItemsBySerials([serial], "RECEIVED");
            const otherAssigned = alreadyAssigned.find(a => a.id !== itemStat.itemId);

            if (otherAssigned) {
              throw new AppError(`الرقم التسلسلي ${serial} مستخدم بالفعل ومستلم في الطلب رقم ${otherAssigned.requestId}`, 400);
            }
          }
        }

        for (const itemStat of itemStatuses) {
          const updateFields: any = { status: itemStat.status, updatedAt: new Date() };
          if (itemStat.serialNumber) updateFields.serialNumber = itemStat.serialNumber;
          if (itemStat.simSerial) updateFields.simSerial = itemStat.simSerial;

          await ctx.requestsRepository.updateRequestItem(itemStat.itemId, updateFields);
        }
      }

      // Re-fetch items inside transaction to get latest statuses
      const latestItems = await ctx.requestsRepository.findRequestItems(requestId);

      const receivedCount = latestItems.filter(item => item.status === "RECEIVED").length;
      const totalCount = latestItems.length;

      // Determine new execution status
      let newStatus = "RECEIVED";
      if (receivedCount === 0) {
        newStatus = "ACCEPTED";
      } else if (receivedCount < totalCount) {
        newStatus = "PARTIALLY_RECEIVED";
      }

      // Update execution status & store sessionMetadata in extraField1
      const stringifiedMetadata = sessionMetadata ? JSON.stringify(sessionMetadata) : null;
      const existingExecution = await ctx.executionsRepository.findExecutionByRequestId(requestId);
      if (existingExecution) {
        await ctx.executionsRepository.updateExecution(
          requestId,
          { 
            installationStatus: newStatus, 
            enteredBy: actorId, 
            extraField1: stringifiedMetadata 
          },
          existingExecution.version
        );
      } else {
        await ctx.executionsRepository.insertExecution({
          requestId,
          installationStatus: newStatus,
          enteredBy: actorId,
          extraField1: stringifiedMetadata,
        });
      }

      // 2. Transfer custody of already-registered inventory items.
      // The item's stored itemTypeId is the only authority for its type: receipt
      // never derives, guesses or changes it. A serial with no inventory record
      // has no trusted type (request items carry only a coarse POS/SIM kind and
      // the request's free-text sim/installation fields), so the receipt is
      // rejected rather than minting the item under a guessed type.
      for (const item of latestItems) {
        if (item.status === "RECEIVED") {
          const serial = item.serialNumber || item.simSerial;
          if (serial) {
            // Central Serial Engine: resolve existing row by any equivalent serial form
            const invItem = await ctx.inventoryPort.findItemBySerial(serial);

            if (!invItem) {
              throw new AppError(
                `الرقم التسلسلي ${serial} غير مسجل في المخزون، ولا يوجد نوع صنف معتمد له. يجب تسجيل الصنف بنوعه الصحيح في المخزون قبل تأكيد الاستلام.`,
                400
              );
            }

            // Idempotent: progressive receipt re-processes every RECEIVED item on
            // each call, so an item already in this technician's custody must not
            // get a second transaction/history/custody movement.
            const alreadyHeldByActor =
              invItem.currentOwnerId === actorId && invItem.status === "RECEIVED_BY_TECHNICIAN";
            if (alreadyHeldByActor) continue;

            await ctx.inventoryPort.transferCustodyToTechnician({
              itemId: invItem.id,
              technicianId: actorId,
              requestId,
              oldStatus: invItem.status,
              newStatus: "RECEIVED_BY_TECHNICIAN"
            });
          }
        }
      }

      // Log Audit
      await ctx.dashboardRepository.insertAuditLog({
        tableName: "requests",
        recordId: requestId,
        action: `confirm_receiving_${newStatus.toLowerCase()}`,
        changedBy: actorId,
      });
    });

    return this.getRequestById(requestId);
  }

  async startTask(requestId: number, actorId: string): Promise<any> {
    const requestItems = await this.requestsRepo.findRequestItems(requestId);
    const execution = await this.executionsRepo.findExecutionByRequestId(requestId);

    if (!execution) {
      throw new Error("الطلب غير مستلم بعد أو لا توجد جلسة استلام");
    }

    await this.uow.execute(async (ctx) => {
      // 1. Update execution status to IN_TRANSIT
      await ctx.executionsRepository.updateExecution(
        requestId,
        { installationStatus: "IN_TRANSIT", enteredBy: actorId },
        execution.version
      );

      // 2. Transition items from RECEIVED_BY_TECHNICIAN to IN_TRANSIT
      for (const item of requestItems) {
        if (item.status === "RECEIVED") {
          const serial = item.serialNumber || item.simSerial;
          if (serial) {
            const invItem = await ctx.inventoryPort.findItemBySerial(serial);

            if (invItem && invItem.status === "RECEIVED_BY_TECHNICIAN") {
              await ctx.inventoryPort.transferCustodyToTechnician({
                itemId: invItem.id,
                technicianId: actorId,
                requestId,
                oldStatus: "RECEIVED_BY_TECHNICIAN",
                newStatus: "IN_TRANSIT"
              });
            }
          }
        }
      }

      // Log Audit
      await ctx.dashboardRepository.insertAuditLog({
        tableName: "requests",
        recordId: requestId,
        action: "start_task",
        changedBy: actorId,
      });
    });

    return this.getRequestById(requestId);
  }

  async saveExecution(requestId: number, data: any, enteredBy: string): Promise<any> {
    // Check if execution exists
    const existing = await this.executionsRepo.findExecutionByRequestId(requestId);
    const request = await this.requestsRepo.findRequestById(requestId);

    if (!request) {
      throw new Error("الطلب غير موجود");
    }

    // Whitelist writable columns only — client payloads often include enteredAt/updatedAt
    // as ISO strings which crash drizzle timestamp mapping (value.toISOString).
    const version = data?.version;
    const sanitized = CourierService.sanitizeExecutionPayload(data);
    const isCompleted = isCompletedStatus(sanitized.installationStatus);

    // Multi-serial close: arrays from portal; fall back to scalar sn / simSerial.
    // Incomplete statuses never require serials and never deduct — omit serial fields from write.
    let deviceSerials = normalizeSerialList(data?.deviceSerials, data?.sn, sanitized.sn);
    let simSerials = normalizeSerialList(data?.simSerials, data?.simSerial, sanitized.simSerial);

    if (!isCompleted) {
      delete sanitized.sn;
      delete sanitized.simSerial;
      deviceSerials = [];
      simSerials = [];
    } else {
      sanitized.sn = deviceSerials[0] ?? null;
      sanitized.simSerial = simSerials[0] ?? null;
    }

    // ─── Guard Validation Layer ───────────────────────────────────────────────
    const techUser = await CompletionGuard.run({
      requestId,
      enteredBy,
      executionData: { ...sanitized, deviceSerials, simSerials },
      request,
      existingExecution: existing ?? null,
      requestsRepo: this.requestsRepo,
      dashboardRepo: this.dashboardRepo,
      inventoryPort: this.inventoryPort,
    });
    // ─────────────────────────────────────────────────────────────────────────

    if (techUser && isCompleted) {
      sanitized.technicianCode = techUser.username;
      sanitized.salesTechnician = techUser.fullName;
    }

    let result: any;
    await this.uow.execute(async (ctx) => {
      if (existing) {
        result = await ctx.executionsRepository.updateExecution(
          requestId,
          { ...sanitized, enteredBy },
          version
        );

        if (!result) {
          throw new OptimisticLockException(
            "courier_executions",
            existing.id,
            version,
            existing.version
          );
        }
      } else {
        result = await ctx.executionsRepository.insertExecution(
          {
            ...sanitized,
            requestId,
            enteredBy,
          }
        );
      }

      // Log audit
      await ctx.dashboardRepository.insertAuditLog({
        tableName: "executions",
        recordId: requestId,
        action: existing ? "update" : "create",
        changedBy: enteredBy
      });

      // Publish ExecutionSavedEvent (inside tx so it is saved to outbox atomically)
      const eventBus = EventBus.getInstance();
      await eventBus.publish(
        new ExecutionSavedEvent({
          requestId,
          actorId: enteredBy,
          execution: result,
          request,
        }),
        ctx.tx
      );
    });

    if (!result) {
      throw new Error("Failed to save execution: database returned no rows.");
    }

    // ─── Workflow Engine ──────────────────────────────────────────────────────
    // Called AFTER guards pass and execution is written to DB.
    // The engine decides the action and delegates side effects.
    if (isCompleted) {
      const workflowResult = await CourierWorkflow.execute({
        requestId,
        actorId: enteredBy,
        execution: result,
        request,
      });

      if (workflowResult.sideEffectErrors.length > 0) {
        console.warn(
          `[Workflow] Request ${requestId} completed with side-effect warnings:`,
          workflowResult.sideEffectErrors
        );
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    return this.getRequestById(requestId);
  }

  /**
   * Serial Lookup — Central Serial Engine entry for close-order UI.
   * Returns item + custody owner technician for auto-fill (read-only in portal).
   */
  async serialLookup(rawSerial: string): Promise<any> {
    let recognition: any = null;
    try {
      recognition = await SerialRecognitionService.recognize(rawSerial);
    } catch {
      // Still try DB lookup
    }

    const item = await this.inventoryPort.findItemBySerial(rawSerial);

    if (!item) {
      try {
        const itemRows = await db
          .select({
            id: items.id,
            serialNumber: items.serialNumber,
            simSerial: items.simSerial,
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
              eq(items.simSerial, rawSerial),
              eq(items.barcode, rawSerial),
              ilike(items.serialNumber, `%${rawSerial}%`),
              ilike(items.simSerial, `%${rawSerial}%`)
            )
          )
          .limit(1);

        if (itemRows.length > 0) {
          const dbItem = itemRows[0];
          return {
            found: true,
            serial: rawSerial,
            normalized: dbItem.serialNumber,
            simSerial: dbItem.simSerial || dbItem.serialNumber,
            carrierName: dbItem.carrierName,
            technician: dbItem.currentOwnerId ? {
              id: dbItem.currentOwnerId,
              fullName: dbItem.technicianName,
              username: dbItem.technicianCode,
              technicianCode: dbItem.technicianCode,
            } : null,
            custodyStatus: dbItem.status,
            message: dbItem.technicianName
              ? `مسجلة ومخصصة للفني: ${dbItem.technicianName} (${dbItem.technicianCode || ""})`
              : "موجودة في المخزون العام (غير مخصصة لفني معين)",
          };
        }
      } catch (err: any) {
        console.error("[SerialLookup] DB fallback search warning:", err.message);
      }

      return {
        found: false,
        serial: rawSerial,
        normalized: recognition?.normalizedSerial ?? rawSerial,
        itemType: recognition
          ? {
              id: recognition.itemTypeId,
              nameAr: recognition.nameAr,
              category: recognition.category,
              carrierName: recognition.carrierName,
            }
          : null,
        technician: null,
        custodyStatus: null,
        linkedRequest: null,
        ownershipValid: false,
        message: "الرقم التسلسلي غير موجود في المخزون — قد يكون غير مسجل بعد",
      };
    }

    const itemTypeRow = await this.inventoryPort.findItemTypeById(item.itemTypeId);

    const carrierName = itemTypeRow
      ? SerialRecognitionService.resolveCarrierName(
          itemTypeRow.id,
          itemTypeRow.nameEn,
          itemTypeRow.nameAr
        )
      : null;

    let technician: {
      id: string;
      fullName: string;
      username: string;
      technicianCode: string | null;
    } | null = null;
    if (item.currentOwnerId) {
      const tech = await this.inventoryPort.findUserById(item.currentOwnerId);
      if (tech) technician = tech;
    }

    const linkedRequestItem = await this.inventoryPort.findLinkedRequestItemBySerial(item.serialNumber);

    let linkedRequest: any = null;
    if (linkedRequestItem?.requestId) {
      const req = await this.requestsRepo.findRequestById(linkedRequestItem.requestId);
      if (req) {
        linkedRequest = {
          requestId: req.id,
          tid: req.tid,
          terminalId: req.terminalId,
          customerName: req.customerName,
          installationType: req.installationType,
          itemStatus: linkedRequestItem.status,
        };
      }
    }

    const isInActiveCustody = (ACTIVE_CUSTODY_STATUSES as readonly string[]).includes(item.status);

    return {
      found: true,
      serial: rawSerial,
      normalized: item.serialNumber,
      item: {
        id: item.id,
        serialNumber: item.serialNumber,
        status: item.status,
        barcode: item.barcode,
      },
      itemType: itemTypeRow
        ? {
            id: itemTypeRow.id,
            nameAr: itemTypeRow.nameAr,
            category: itemTypeRow.category,
            carrierName,
          }
        : null,
      technician,
      custodyStatus: item.status,
      inActiveCustody: isInActiveCustody,
      linkedRequest,
      ownershipValid: !!technician && isInActiveCustody,
      message: technician
        ? `مسجلة ومخصصة للفني: ${technician.fullName} (${technician.username || ""})`
        : "موجودة في المخزون العام",
    };
  }

  async getLookups(): Promise<any> {
    return this.requestsRepo.getLookups();
  }

  async getDashboardStats(): Promise<any> {
    return this.dashboardRepo.getDashboardStats();
  }

  async getAiMonitorStats(): Promise<any> {
    return this.dashboardRepo.getAiMonitorStats();
  }

  async listAuditLogs(): Promise<any[]> {
    return this.dashboardRepo.listAuditLogs(100);
  }

  /**
   * OCR first; if no devices found, try Vision using admin AI settings (PR-006A-10 Slice 2).
   */
  private async extractPdfPayload(buffer: Buffer, forceAi = false, fileName?: string): Promise<{
    extraction: { fields: any; overallConfidence: number; rawText: string };
    extractedPayload: ReturnType<typeof buildExtractedPayloadFromOcr>;
    status: string;
    visionError: string | null;
  }> {
    let status = "pending";
    let extraction;
    let extractedPayload: ReturnType<typeof buildExtractedPayloadFromOcr>;
    let visionError: string | null = null;

    try {
      const { getActiveVisionCredentials } = await import(
        "../../ai-engine-settings/contracts"
      );
      const creds = getActiveVisionCredentials();

      if (creds.enabled || forceAi) {
        const aiResult = await runAiEngineExtraction(buffer, fileName);
        if (aiResult.ok) {
          extractedPayload = aiResult.payload;
          extraction = {
            fields: aiResult.payload,
            overallConfidence:
              aiResult.payload.devices.reduce((s, d) => s + (d.confidence || 0), 0) /
                Math.max(1, aiResult.payload.devices.length) || 0,
            rawText: "[AI Vision] Extracted via configured Gemini provider.",
          };
          return { extraction, extractedPayload, status, visionError: null };
        } else {
          visionError = aiResult.error;
        }
      }

      extraction = await extractFromPdf(buffer);
      extractedPayload = buildExtractedPayloadFromOcr(extraction.fields);

      if (!extractedPayload.devices.length && !creds.enabled && !forceAi) {
        const aiResult = await runAiEngineExtraction(buffer, fileName);
        if (aiResult.ok) {
          extractedPayload = aiResult.payload;
          extraction = {
            fields: aiResult.payload,
            overallConfidence:
              aiResult.payload.devices.reduce((s, d) => s + (d.confidence || 0), 0) /
                Math.max(1, aiResult.payload.devices.length) || 0,
            rawText: extraction.rawText || "[AI Vision] Extracted via configured Gemini provider.",
          };
          visionError = null;
        } else {
          visionError = aiResult.error;
        }
      }
    } catch (err) {
      status = "failed";
      extraction = { fields: {}, overallConfidence: 0, rawText: (err as Error).message };
      extractedPayload = buildExtractedPayloadFromOcr({});
      visionError = (err as Error).message;
    }

    return { extraction, extractedPayload, status, visionError };
  }

  async uploadPdfReport(
    fileName: string,
    storedName: string,
    buffer: Buffer,
    uploadedBy: string,
    requestId?: number,
    preExtractedJson?: string | object,
    preConfidence?: number
  ): Promise<any> {
    let extraction: { fields: any; overallConfidence: number; rawText: string };
    let extractedPayload: ReturnType<typeof buildExtractedPayloadFromOcr>;
    let status = "pending";
    let visionError: string | null = null;

    if (preExtractedJson) {
      let parsed: any;
      try {
        parsed = typeof preExtractedJson === "string" ? JSON.parse(preExtractedJson) : preExtractedJson;
      } catch {
        parsed = {};
      }
      extractedPayload = ensureDevicesInExtractedJson(parsed);
      const conf = preConfidence ?? 90;
      extraction = {
        fields: extractedPayload,
        overallConfidence: conf,
        rawText: "[Pre-Extracted via Telegram Bot Vision]",
      };
    } else {
      const res = await this.extractPdfPayload(buffer, false, fileName);
      extraction = res.extraction;
      extractedPayload = res.extractedPayload;
      status = res.status;
      visionError = res.visionError;
    }

    let finalRequestId = requestId || null;
    if (!finalRequestId) {
      const payloadAny = extractedPayload as any;
      if (payloadAny.request_number?.value) {
        const parsedId = parseInt(payloadAny.request_number.value, 10);
        if (!isNaN(parsedId)) {
          const req = await this.requestsRepo.findRequestById(parsedId);
          if (req) {
            finalRequestId = req.id;
          }
        }
      }
      if (!finalRequestId && payloadAny.tid?.value) {
        const req = await this.requestsRepo.findRequestByTid(payloadAny.tid.value);
        if (req) {
          finalRequestId = req.id;
        }
      }
      if (!finalRequestId && Array.isArray(payloadAny.devices)) {
        for (const dev of payloadAny.devices) {
          if (dev.tid) {
            const req = await this.requestsRepo.findRequestByTid(dev.tid);
            if (req) {
              finalRequestId = req.id;
              break;
            }
          }
        }
      }
    }

    let finalStatus = status;
    if (status === "pending") {
      const payloadAny = extractedPayload as any;
      const hasDevices = Array.isArray(payloadAny.devices) && payloadAny.devices.length > 0;
      const isMissingCritical = 
        !finalRequestId || 
        (!hasDevices && (!payloadAny.sn?.value || !payloadAny.sim_serial?.value || !payloadAny.tid?.value));
      if (isMissingCritical && extraction.overallConfidence < 80) {
        finalStatus = "manual_review";
      }
    }

    const newReport = await this.pdfRepo.insertPdfReport({
      requestId: finalRequestId,
      fileName,
      filePath: storedName,
      uploadedBy,
      ocrText: extraction.rawText,
      extractedJson: JSON.stringify(extractedPayload),
      overallConfidence: extraction.overallConfidence,
      status: finalStatus
    });

    return {
      id: newReport.id,
      fields: extractedPayload,
      devices: extractedPayload.devices,
      overallConfidence: extraction.overallConfidence,
      status: finalStatus,
      extraction_source: extractedPayload.extraction_source,
      visionError,
    };
  }

  /**
   * تسجيل تقرير PDF مرجعيًا برابط Google Drive فقط - بدون رفع أي بايتات فعلية أو كتابة
   * ملف على قرص السيرفر. يُستخدم حصرًا من بوت تيليجرام (installation_bot.py) الذي يرفع
   * الملف الأصلي إلى Drive بنفسه أولًا؛ filePath هنا يحمل رابط Drive الكامل بدل مسار قرص
   * محلي - راجع getPdfReportById/الطبقة الأمامية حيث يُكتشف ذلك عبر بادئة http(s) ويُفتح
   * الرابط مباشرة بدل قراءة الملف من القرص. بما أنه لا توجد بايتات هنا، لا تشغيل OCR/AI محلي؛
   * preExtractedJson (بيانات الفني المستخرجة مسبقًا عبر Gemini داخل البوت) إلزامي عمليًا،
   * وإلا يُسجَّل التقرير فارغ الحقول بانتظار /update-extracted اللاحق من البوت.
   */
  async registerPdfReportFromDriveUrl(
    fileName: string,
    driveUrl: string,
    uploadedBy: string,
    requestId?: number,
    preExtractedJson?: string | object,
    preConfidence?: number
  ): Promise<any> {
    let extractedPayload: ReturnType<typeof buildExtractedPayloadFromOcr>;
    let overallConfidence = preConfidence ?? 0;

    if (preExtractedJson) {
      let parsed: any;
      try {
        parsed = typeof preExtractedJson === "string" ? JSON.parse(preExtractedJson) : preExtractedJson;
      } catch {
        parsed = {};
      }
      extractedPayload = ensureDevicesInExtractedJson(parsed);
      overallConfidence = preConfidence ?? 90;
    } else {
      extractedPayload = ensureDevicesInExtractedJson({ devices: [] } as any);
    }

    let finalRequestId = requestId || null;
    if (!finalRequestId) {
      const payloadAny = extractedPayload as any;
      if (payloadAny.request_number?.value) {
        const parsedId = parseInt(payloadAny.request_number.value, 10);
        if (!isNaN(parsedId)) {
          const req = await this.requestsRepo.findRequestById(parsedId);
          if (req) finalRequestId = req.id;
        }
      }
      if (!finalRequestId && payloadAny.tid?.value) {
        const req = await this.requestsRepo.findRequestByTid(payloadAny.tid.value);
        if (req) finalRequestId = req.id;
      }
    }

    const hasDevices = Array.isArray((extractedPayload as any).devices) && (extractedPayload as any).devices.length > 0;
    const status = finalRequestId && hasDevices ? "pending" : "manual_review";

    const newReport = await this.pdfRepo.insertPdfReport({
      requestId: finalRequestId,
      fileName,
      filePath: driveUrl,
      uploadedBy,
      ocrText: "[Google Drive - لا يوجد استخراج محلي، البيانات من البوت]",
      extractedJson: JSON.stringify(extractedPayload),
      overallConfidence,
      status,
    });

    return {
      id: newReport.id,
      fields: extractedPayload,
      devices: (extractedPayload as any).devices,
      overallConfidence,
      status,
      extraction_source: (extractedPayload as any).extraction_source,
      driveUrl,
    };
  }

  async updatePdfReportExtractedJson(
    pdfId: number,
    extractedJson: any,
    overallConfidence?: number,
    requestId?: number
  ): Promise<any> {
    const report = await this.pdfRepo.findPdfReportById(pdfId);
    if (!report) {
      throw new NotFoundError("PDF Report not found");
    }

    const payload = ensureDevicesInExtractedJson(extractedJson);
    const updated = await this.pdfRepo.updatePdfReport(pdfId, {
      extractedJson: JSON.stringify(payload),
      overallConfidence: overallConfidence ?? report.overallConfidence,
      requestId: requestId ?? report.requestId,
      status: payload.devices.length > 0 ? "pending" : report.status,
    });

    return updated;
  }

  async reextractPdfReport(pdfId: number): Promise<any> {
    const report = await this.getPdfReportById(pdfId);
    if (!report) {
      throw new NotFoundError("PDF Report not found");
    }

    let buffer: Buffer | null = null;
    const isExternalUrl = /^https?:\/\//i.test(report.filePath || "");

    if (isExternalUrl) {
      // Zero-storage mode: File is hosted on Google Drive / External URL.
      // Parse and re-normalize extractedJson in memory.
      const currentPayload = ensureDevicesInExtractedJson(report.extractedJson);
      const updated = await this.pdfRepo.updatePdfReport(pdfId, {
        extractedJson: JSON.stringify(currentPayload),
        overallConfidence: report.overallConfidence ?? 90,
      });
      return {
        id: updated.id,
        fields: currentPayload,
        devices: (currentPayload as any).devices,
        overallConfidence: updated.overallConfidence,
        status: updated.status,
        extraction_source: (currentPayload as any).extraction_source || "ai_engine",
      };
    }

    const uploadDir = path.join(process.cwd(), "uploads", "pdf");
    const filePath = path.join(uploadDir, report.filePath);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundError("File not found on disk");
    }

    buffer = fs.readFileSync(filePath);
    const { extraction, extractedPayload, status, visionError } = await this.extractPdfPayload(buffer, true, report.fileName);

    let finalRequestId = report.requestId;
    if (!finalRequestId) {
      const payloadAny = extractedPayload as any;
      if (payloadAny.request_number?.value) {
        const parsedId = parseInt(payloadAny.request_number.value, 10);
        if (!isNaN(parsedId)) {
          const req = await this.requestsRepo.findRequestById(parsedId);
          if (req) {
            finalRequestId = req.id;
          }
        }
      }
      if (!finalRequestId && payloadAny.tid?.value) {
        const req = await this.requestsRepo.findRequestByTid(payloadAny.tid.value);
        if (req) {
          finalRequestId = req.id;
        }
      }
    }

    let finalStatus = status === "failed" ? "failed" : report.status === "applied" ? report.status : "pending";
    if (finalStatus === "pending") {
      const payloadAny = extractedPayload as any;
      const isMissingCritical = 
        !finalRequestId || 
        !payloadAny.sn?.value || 
        !payloadAny.sim_serial?.value || 
        !payloadAny.tid?.value;
      if (isMissingCritical) {
        finalStatus = "manual_review";
      }
    }

    const updated = await this.pdfRepo.updatePdfReport(pdfId, {
      ocrText: extraction.rawText,
      extractedJson: JSON.stringify(extractedPayload),
      overallConfidence: extraction.overallConfidence,
      status: finalStatus,
      requestId: finalRequestId,
    });

    return {
      id: updated.id,
      fields: extractedPayload,
      devices: updated.status === "failed" ? [] : extractedPayload.devices,
      overallConfidence: extraction.overallConfidence,
      status: updated.status,
      extraction_source: extractedPayload.extraction_source,
      extractedJson: extractedPayload,
      visionError,
    };
  }

  async completePdfReport(
    pdfId: number,
    requestId: number,
    body: {
      devices: CompleteDeviceInput[];
      deliveryDate?: string | null;
      time?: string | null;
      paperRoll?: string | null;
      version?: number;
    },
    enteredBy: string,
  ): Promise<any> {
    const report = await this.getPdfReportById(pdfId);
    if (!report) {
      throw new NotFoundError("PDF Report not found");
    }
    if (report.status === "applied") {
      throw new AppError("هذا التقرير مُطبَّق بالفعل", 400);
    }

    const devices = Array.isArray(body.devices) ? body.devices : [];
    if (devices.length === 0) {
      throw new AppError("لا توجد أجهزة للإكمال", 400);
    }

    const hasSerial = devices.some((d) => (d.sn ?? "").trim() || (d.sim_serial ?? "").trim());
    if (!hasSerial) {
      throw new AppError("يجب إدخال رقم جهاز أو شريحة واحد على الأقل", 400);
    }

    const executionPayload = buildCompleteExecutionPayload({
      devices,
      deliveryDate: body.deliveryDate,
      time: body.time,
      paperRoll: body.paperRoll,
      version: body.version,
    });

    const saved = await this.saveExecution(requestId, executionPayload, enteredBy);

    await this.pdfRepo.updatePdfReport(pdfId, {
      status: "applied",
      requestId,
    });

    await this.dashboardRepo.insertAuditLog({
      tableName: "pdf_reports",
      recordId: pdfId,
      action: "complete",
      changedBy: enteredBy,
    });

    if (report && report.uploadedBy) {
      const approveMsg = `<b>✅ تم اعتماد تقرير التركيب بنجاح</b>\n\n` +
        `<b>رقم التقرير:</b> #${pdfId}\n` +
        (requestId ? `<b>رقم الطلب:</b> #${requestId}\n` : "") +
        `شكراً لالتزامك وتوثيق التركيب.`;
      this.notifyTelegramUser(report.uploadedBy, approveMsg).catch(() => {});
    }

    return {
      ...saved,
      pdf: { id: pdfId, status: "applied", requestId },
    };
  }

  async rejectPdfReport(
    pdfId: number,
    reasonCategory: string,
    notes: string,
    actorId: string
  ): Promise<any> {
    const report = await this.getPdfReportById(pdfId);
    if (!report) {
      throw new NotFoundError("PDF Report not found");
    }

    const updated = await this.pdfRepo.updatePdfReport(pdfId, {
      status: "rejected",
    });

    await this.dashboardRepo.insertAuditLog({
      tableName: "pdf_reports",
      recordId: pdfId,
      action: "reject",
      changedBy: actorId,
    });

    if (report.uploadedBy) {
      const reasonLabels: Record<string, string> = {
        UNCLEAR_PHOTO: "صورة المستند/الملصق غير واضحة",
        SERIAL_MISMATCH: "الرقم التسلسلي للجهاز غير مطابق",
        SIM_MISMATCH: "رقم الشريحة غير مطابق",
        MERCHANT_TID_MISMATCH: "بيانات التاجر / TID غير مطابقة",
        OTHER: "أسباب أخرى",
      };
      const categoryLabel = reasonLabels[reasonCategory] || reasonCategory;
      const msg = `<b>⚠️ تم إرجاع تقرير التركيب للمراجعة</b>\n\n` +
        `<b>السبب الرئيسي:</b> ${categoryLabel}\n` +
        (notes ? `<b>📝 ملاحظة المشرف:</b> ${notes}\n\n` : "\n") +
        `🔄 يرجى إعادة تصوير التقرير ورفعه مجدداً عبر البوت.`;
      
      // محاولة استخراج telegram_message_id من extractedJson للرد على نفس الرسالة
      let telegramReplyToMessageId: number | null = null;
      try {
        if (report.extractedJson) {
          const parsedJson = typeof report.extractedJson === "string"
            ? JSON.parse(report.extractedJson)
            : report.extractedJson;
          if (parsedJson?.telegram_message_id) {
            telegramReplyToMessageId = Number(parsedJson.telegram_message_id);
          }
        }
      } catch {}

      this.notifyTelegramUser(report.uploadedBy, msg, telegramReplyToMessageId ?? undefined).catch(() => {});
    }

    return { id: pdfId, status: "rejected", reasonCategory, notes };
  }

  private async notifyTelegramUser(userId: string, htmlMessage: string, replyToMessageId?: number): Promise<void> {
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN || "8829774810:AAG-bnlRiTZAoHfvijp7erQmRKDBPxBfOFw";
      const techUser = await this.inventoryPort.findUserById(userId);
      const chatId = (techUser as any)?.telegram_user_id || techUser?.username;
      if (!chatId || !botToken) return;

      const payload: Record<string, any> = {
        chat_id: chatId,
        text: htmlMessage,
        parse_mode: "HTML",
      };

      // إذا توفّر رقم رسالة التليجرام الأصلية، يتم الرد عليها مباشرةً
      if (replyToMessageId && !isNaN(replyToMessageId) && replyToMessageId > 0) {
        payload.reply_parameters = { message_id: replyToMessageId };
      }

      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("[TelegramNotify] Error sending notification:", err);
    }
  }

  async applyPdfReport(pdfId: number, requestId: number, fields: any, confidence: any, uploadedBy: string): Promise<any> {
    const existing = await this.executionsRepo.findExecutionByRequestId(requestId);
    const merged: Record<string, any> = { ...existing };
    const execFields = [
      "requestPriorityLevel", "pushBack", "installationStatus", "paperRoll",
      "time", "deliveryDate", "responseDate", "sn", "simSerial", "simType",
      "customerNotes", "extraField1", "extraField2", "responseReasonCode",
      "salesTechnician", "technicianCode"
    ];
    for (const f of execFields) {
      if (f in fields) merged[f] = fields[f];
    }

    let result: any;
    let pdfRequest: any;
    await this.uow.execute(async (ctx) => {
      if (existing) {
        const version = fields.version;
        result = await ctx.executionsRepository.updateExecution(
          requestId,
          {
            ...merged,
            extractionConfidence: JSON.stringify(confidence),
            enteredBy: uploadedBy,
          },
          version
        );

        if (!result) {
          throw new OptimisticLockException("courier_executions", existing.id, version, existing.version);
        }
      } else {
        result = await ctx.executionsRepository.insertExecution({
          requestId,
          ...merged,
          extractionConfidence: JSON.stringify(confidence),
          enteredBy: uploadedBy,
        });
      }

      await ctx.pdfRepository.updatePdfReport(pdfId, {
        status: "applied",
        requestId
      });

      await ctx.dashboardRepository.insertAuditLog({
        tableName: "executions",
        recordId: requestId,
        action: existing ? "update" : "create",
        changedBy: uploadedBy,
      });

      pdfRequest = await ctx.requestsRepository.findRequestById(requestId);

      if (pdfRequest) {
        const eventBus = EventBus.getInstance();
        await eventBus.publish(
          new ExecutionSavedEvent({
            requestId,
            actorId: uploadedBy,
            execution: result,
            request: pdfRequest,
          }),
          ctx.tx
        );
      }
    });

    if (!result) {
      throw new Error("Failed to save execution from PDF report: database returned no rows.");
    }

    const isCompleted = isCompletedStatus(merged.installationStatus);
    if (isCompleted && pdfRequest) {
      const workflowResult = await CourierWorkflow.execute({
        requestId,
        actorId: uploadedBy,
        execution: result,
        request: pdfRequest,
      });

      if (workflowResult.sideEffectErrors.length > 0) {
        console.warn(
          `[Workflow] PDF apply for request ${requestId} completed with warnings:`,
          workflowResult.sideEffectErrors
        );
      }
    }

    return this.getRequestById(requestId);
  }

  async getPdfReports(filters?: { region?: string; technician?: string; q?: string }): Promise<any[]> {
    return this.pdfRepo.listPdfReports(filters);
  }

  async getPdfReportById(id: number): Promise<any | null> {
    return this.pdfRepo.findPdfReportById(id);
  }

  async importRawRequests(buffer: Buffer, createdBy: string): Promise<any> {
    // ADR-002 Commit 3: parseRawDataWorkbook is now async (ExcelJS has no
    // synchronous buffer reader). It throws a typed SpreadsheetError for
    // invalid/empty files and for formula/error/unsupported cells in mapped
    // fields; those propagate to the errorHandler as safe 400 responses.
    const summary = await parseRawDataWorkbook(buffer);
    const importedList = [];
    const skippedList = [];

    for (const item of summary.imported) {
      const data = item.data;
      // Prevent duplicate TID/Terminal ID
      if (data.tid) {
        const existing = await this.requestsRepo.findRequestByTid(data.tid);
        if (existing) {
          skippedList.push({
            rowNumber: item.rowNumber,
            data,
            error: `TID ${data.tid} already exists.`
          });
          continue;
        }
      }

      const newRequest = await this.requestsRepo.insertRequest({
        date: data.date,
        installationType: data.installationType,
        sim: data.sim,
        tid: data.tid,
        otp: data.otp,
        ticketingHolouly: data.ticketingHolouly,
        incidentNumber: data.incidentNumber,
        pinCode: data.pinCode,
        trsm: data.trsm,
        terminalId: data.terminalId,
        simSn: data.simSn,
        idData: data.idData,
        vendorType: data.vendorType,
        city: data.city,
        cityTec: data.cityTec,
        customerName: data.customerName,
        retailerName: data.retailerName,
        addressAr: data.addressAr,
        addressEn: data.addressEn,
        mobile: data.mobile,
        mobile2: data.mobile2,
        tecName: data.tecName,
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // === Auto-create execution if Excel contains field/device completion data ===
      const hasExecutionData = !!(data.sn || data.simSerial || data.installationStatus || data.salesTechnician || data.deliveryDate);
      if (hasExecutionData) {
        try {
          const normalizeStatus = (s: string | null | undefined): string => {
            if (!s) return "Installation Completed";
            const lower = s.toLowerCase();
            if (lower.includes("complet")) return "Installation Completed";
            if (lower.includes("not") || lower.includes("غير")) return "Not Completed";
            if (lower.includes("progress") || lower.includes("إجراء")) return "In Progress";
            if (lower.includes("answer") || lower.includes("يرد")) return "Customer Not Answering";
            return s; // keep original if unrecognized
          };

          await this.executionsRepo.insertExecution({
            requestId: newRequest.id,
            installationStatus: normalizeStatus(data.installationStatus),
            sn: data.sn || null,
            simSerial: data.simSerial || null,
            salesTechnician: data.salesTechnician || data.tecName || null,
            technicianCode: data.technicianCode || null,
            deliveryDate: data.deliveryDate || data.date || null,
            time: data.time || null,
            enteredBy: createdBy,
          });
        } catch (execErr) {
          // Non-fatal: log but don't fail the row import
          console.warn(`[importRawRequests] Could not auto-create execution for request ${newRequest.id}:`, execErr);
        }
      }

      importedList.push({ rowNumber: item.rowNumber, id: newRequest.id, tid: newRequest.tid, hasExecution: hasExecutionData });
    }

    return {
      totalRows: summary.totalRows,
      importedCount: importedList.length,
      rejectedCount: summary.rejected.length,
      skippedCount: skippedList.length,
      rejected: summary.rejected,
      skipped: skippedList,
      imported: importedList
    };
  }

  async exportRequests(filters: ListFilters): Promise<Buffer> {
    const mappedRows = await this.requestsRepo.listRequestsForExport(filters);
    return buildExportWorkbook(mappedRows);
  }

  async countRequests(filters: ListFilters): Promise<number> {
    return this.requestsRepo.countRequests(filters);
  }

  async startRoute(requestId: number, actorId: string): Promise<any> {
    return this.uow.execute(async (ctx) => {
      const request = await ctx.requestsRepository.findRequestById(requestId);
      if (!request) throw new NotFoundError("Request not found");

      const execution = await ctx.executionsRepository.findExecutionByRequestId(requestId);
      if (!execution) throw new NotFoundError("Execution not found");

      const updatedExecution = await ctx.executionsRepository.updateExecution(
        requestId,
        {
          installationStatus: "ON_ROUTE",
          updatedAt: new Date()
        },
        execution.version
      );

      if (!updatedExecution) {
        throw new OptimisticLockException("courier_executions", execution.id, execution.version);
      }

      await ctx.dashboardRepository.insertAuditLog({
        tableName: "courier_executions",
        recordId: execution.id,
        fieldName: "installation_status",
        oldValue: execution.installationStatus,
        newValue: "ON_ROUTE",
        action: "START_ROUTE",
        changedBy: actorId
      });

      return { success: true, status: "ON_ROUTE" };
    });
  }

  async arriveCustomer(requestId: number, actorId: string): Promise<any> {
    return this.uow.execute(async (ctx) => {
      const request = await ctx.requestsRepository.findRequestById(requestId);
      if (!request) throw new NotFoundError("Request not found");

      const execution = await ctx.executionsRepository.findExecutionByRequestId(requestId);
      if (!execution) throw new NotFoundError("Execution not found");

      const updatedExecution = await ctx.executionsRepository.updateExecution(
        requestId,
        {
          installationStatus: "ARRIVED",
          updatedAt: new Date()
        },
        execution.version
      );

      if (!updatedExecution) {
        throw new OptimisticLockException("courier_executions", execution.id, execution.version);
      }

      await ctx.dashboardRepository.insertAuditLog({
        tableName: "courier_executions",
        recordId: execution.id,
        fieldName: "installation_status",
        oldValue: execution.installationStatus,
        newValue: "ARRIVED",
        action: "ARRIVE_CUSTOMER",
        changedBy: actorId
      });

      return { success: true, status: "ARRIVED" };
    });
  }

  async startInstallation(requestId: number, actorId: string): Promise<any> {
    return this.uow.execute(async (ctx) => {
      const request = await ctx.requestsRepository.findRequestById(requestId);
      if (!request) throw new NotFoundError("Request not found");

      const execution = await ctx.executionsRepository.findExecutionByRequestId(requestId);
      if (!execution) throw new NotFoundError("Execution not found");

      const updatedExecution = await ctx.executionsRepository.updateExecution(
        requestId,
        {
          installationStatus: "INSTALLING",
          updatedAt: new Date()
        },
        execution.version
      );

      if (!updatedExecution) {
        throw new OptimisticLockException("courier_executions", execution.id, execution.version);
      }

      await ctx.dashboardRepository.insertAuditLog({
        tableName: "courier_executions",
        recordId: execution.id,
        fieldName: "installation_status",
        oldValue: execution.installationStatus,
        newValue: "INSTALLING",
        action: "START_INSTALLATION",
        changedBy: actorId
      });

      return { success: true, status: "INSTALLING" };
    });
  }

  async getExecutionAttempts(requestId: number): Promise<CourierExecutionAttempt[]> {
    return this.executionsRepo.findExecutionAttempts(requestId);
  }

  async createExecutionAttempt(
    requestId: number,
    actorId: string,
    data: {
      status: "SUCCESS" | "FAILED";
      failureReasonCode?: string;
      notes?: string;
      snInstalled?: string;
      simInstalled?: string;
      gpsLatitude?: number;
      gpsLongitude?: number;
      batteryLevel?: number;
      networkOperator?: string;
      startTime?: string;
      arrivalTime?: string;
      endTime?: string;
      evidencePhotos?: string[];
      customerSignature?: string;
    }
  ): Promise<any> {
    return this.uow.execute(async (ctx) => {
      const request = await ctx.requestsRepository.findRequestById(requestId);
      if (!request) throw new NotFoundError("Request not found");

      const execution = await ctx.executionsRepository.findExecutionByRequestId(requestId);
      if (!execution) throw new NotFoundError("Execution not found");

      // 1. Determine attempt number
      const existingAttempts = await ctx.executionsRepository.findExecutionAttempts(requestId);
      const attemptNumber = existingAttempts.length + 1;

      // 2. Insert Execution Attempt row
      const attempt = await ctx.executionsRepository.insertExecutionAttempt({
        requestId,
        attemptNumber,
        status: data.status,
        failureReasonCode: data.failureReasonCode || null,
        notes: data.notes || null,
        snInstalled: data.snInstalled || null,
        simInstalled: data.simInstalled || null,
        gpsLatitude: data.gpsLatitude || null,
        gpsLongitude: data.gpsLongitude || null,
        batteryLevel: data.batteryLevel || null,
        networkOperator: data.networkOperator || null,
        startTime: data.startTime ? new Date(data.startTime) : null,
        arrivalTime: data.arrivalTime ? new Date(data.arrivalTime) : null,
        endTime: data.endTime ? new Date(data.endTime) : null,
        evidencePhotos: data.evidencePhotos || null,
        customerSignature: data.customerSignature || null,
        enteredBy: actorId,
      });

      // 3. Handle attempt status transitions
      if (data.status === "SUCCESS") {
        const finalStatus = "Installation Completed";

        // Update execution with details
        const updatedExecution = await ctx.executionsRepository.updateExecution(
          requestId,
          {
            installationStatus: finalStatus,
            sn: data.snInstalled || execution.sn,
            simSerial: data.simInstalled || execution.simSerial,
            responseReasonCode: null,
            customerNotes: data.notes || execution.customerNotes,
            extraField1: data.evidencePhotos ? JSON.stringify(data.evidencePhotos) : execution.extraField1,
            extraField2: data.customerSignature || execution.extraField2,
            updatedAt: new Date()
          },
          execution.version
        );

        if (!updatedExecution) {
          throw new OptimisticLockException("courier_executions", execution.id, execution.version);
        }

        // Update request items status to INSTALLED
        const items = await ctx.requestsRepository.findRequestItems(requestId);
        for (const item of items) {
          if (item.status === "RECEIVED") {
            await ctx.requestsRepository.updateRequestItem(item.id, {
              status: "INSTALLED",
              installedAt: new Date(),
              deliveredAt: new Date(),
            });
          }
        }

        await ctx.dashboardRepository.insertAuditLog({
          tableName: "courier_executions",
          recordId: execution.id,
          fieldName: "installation_status",
          oldValue: execution.installationStatus,
          newValue: finalStatus,
          action: "SUBMIT_EXECUTION_SUCCESS",
          changedBy: actorId
        });

        // Publish ExecutionCompletedEvent to trigger InventoryEngine auto-deduction
        const eventBus = EventBus.getInstance();
        await eventBus.publish(
          new ExecutionCompletedEvent({
            requestId,
            actorId,
            execution: updatedExecution,
            request,
          }),
          ctx.tx
        );
      } else {
        const finalStatus = data.failureReasonCode || "FAILED_ATTEMPT";

        const updatedExecution = await ctx.executionsRepository.updateExecution(
          requestId,
          {
            installationStatus: finalStatus,
            responseReasonCode: data.failureReasonCode || null,
            customerNotes: data.notes || execution.customerNotes,
            updatedAt: new Date()
          },
          execution.version
        );

        if (!updatedExecution) {
          throw new OptimisticLockException("courier_executions", execution.id, execution.version);
        }

        await ctx.dashboardRepository.insertAuditLog({
          tableName: "courier_executions",
          recordId: execution.id,
          fieldName: "installation_status",
          oldValue: execution.installationStatus,
          newValue: finalStatus,
          action: "SUBMIT_EXECUTION_FAILURE",
          changedBy: actorId
        });
      }

      return attempt;
    });
  }

  async linkSimToTechnician(data: {
    simSerial: string;
    simType?: string;
    technicianId?: string;
    technicianUsername?: string;
    notes?: string;
  }): Promise<any> {
    const simSerial = (data.simSerial || "").trim();
    if (!simSerial) throw new ValidationError("رقم الشريحة مطلوب");

    let targetOwnerId = data.technicianId || null;

    if (!targetOwnerId && data.technicianUsername) {
      const uRows = await db
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

    // Check if already exists in items
    const existing = await db
      .select()
      .from(items)
      .where(or(eq(items.serialNumber, simSerial), eq(items.barcode, simSerial)))
      .limit(1);

    // Resolve item type: an already-classified item keeps its stored type
    // (re-deriving from the serial on every re-link risks flipping a correctly
    // classified item when catalog regexes overlap). A genuinely new item needs
    // the caller's explicit simType, which must agree with exactly one live
    // catalog type whose serialRegex accepts the serial — the server never
    // picks a type on its own, even when only one regex happens to match.
    let simTypeId: string;
    let carrierNameFromResolution: string | undefined;
    if (existing.length > 0 && existing[0].itemTypeId) {
      simTypeId = existing[0].itemTypeId;
    } else {
      if (!data.simType || !data.simType.trim()) {
        throw new AppError(
          "شريحة جديدة غير مسجلة: يجب إرسال نوع الشريحة (simType) صراحة؛ لا يحدد الخادم النوع تلقائيًا.",
          400
        );
      }
      const simCandidates = await resolveSimItemTypeCandidates(simSerial, data.simType);
      if (simCandidates.length !== 1) {
        throw new AppError(
          simCandidates.length === 0
            ? "تعذّر تحديد نوع الشريحة من السيريال؛ يجب إرسال simType صريحة أو التأكد من تطابق السيريال لنمط معتمد في كتالوج الأصناف."
            : `السيريال يطابق أكثر من نوع شريحة محتمل في الكتالوج (${simCandidates.map((c) => c.nameEn).join(", ")})؛ يجب إرسال simType صريحة لحسم الاختيار.`,
          400
        );
      }
      simTypeId = simCandidates[0].id;
      carrierNameFromResolution = simCandidates[0].nameEn;
    }

    const resolvedCarrierName =
      data.simType || carrierNameFromResolution || (existing.length > 0 ? existing[0].carrierName : undefined);
    if (!resolvedCarrierName) {
      throw new AppError(
        "تعذّر تحديد شركة الشريحة تلقائيًا؛ يجب إرسال simType صريحة عند عدم وجود سجل سابق لهذه الشريحة.",
        400
      );
    }

    if (existing.length > 0) {
      const [updated] = await db
        .update(items)
        .set({
          currentOwnerId: targetOwnerId || existing[0].currentOwnerId,
          carrierName: resolvedCarrierName,
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

    const [newItem] = await db.insert(items).values({
      itemTypeId: simTypeId,
      serialNumber: simSerial,
      barcode: simSerial,
      carrierName: resolvedCarrierName,
      currentOwnerId: targetOwnerId,
      status: targetOwnerId ? "RECEIVED_BY_TECHNICIAN" : "WAREHOUSE",
    }).returning();

    return {
      success: true,
      message: "تم إدراج الشريحة في المخزون وربطها بالفني بنجاح",
      item: newItem,
    };
  }
}
