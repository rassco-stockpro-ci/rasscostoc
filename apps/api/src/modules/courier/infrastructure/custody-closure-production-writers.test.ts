/**
 * OPS-REMED-E4-P4-I2 — production-writer initialization regression suite.
 *
 * Proves, via the REAL CourierService + DrizzleCourierRepository stack
 * against a real isolated Postgres database, that every one of the six
 * production insertExecution call sites persists the exact semantically
 * correct custodyClosureStatus value derived in the I2 domain trace —
 * not merely that a repository-level insert accepts one of the six
 * frozen values (that is already covered by
 * migration-p4-constraint.smoke.test.ts). Setup patterns (seedTechnician,
 * seedDeviceInCustody, seedRequest, seedPdfReport, completeBody) mirror
 * pdf-report-approval-transaction.test.ts's certified helpers.
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  items,
  courierRequests,
  courierPdfReports,
  courierExecutions,
  courierAuditLogs,
  regions,
  inventoryDeductionCompletions,
} from "@shared/schema";
import { createInventoryEngine } from "../composition/courier.container";
import { CourierService } from "../application/courier.service";
import { DrizzleCourierRepository } from "./repositories/drizzle-courier.repository";
import { DrizzleCourierUnitOfWork } from "./repositories/DrizzleCourierUnitOfWork";
import { EventBus } from "@core/events/event-bus";

describe("OPS-REMED-E4-P4-I2 — production writer custodyClosureStatus initialization", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database " +
          "(must contain 'test' in the database name). See scripts/test-database.mjs."
      );
    }
  });

  const createdUserIds: string[] = [];
  const createdItemTypeIds: string[] = [];
  const createdItemIds: string[] = [];
  const createdRequestIds: number[] = [];
  const createdPdfIds: number[] = [];

  afterEach(async () => {
    for (const id of createdPdfIds.splice(0)) {
      await db
        .delete(courierAuditLogs)
        .where(eq(courierAuditLogs.tableName, "pdf_reports"))
        .catch(() => {});
      await db.delete(courierPdfReports).where(eq(courierPdfReports.id, id)).catch(() => {});
    }
    for (const requestId of createdRequestIds.splice(0)) {
      await db.delete(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, requestId)).catch(() => {});
      await db.delete(courierExecutions).where(eq(courierExecutions.requestId, requestId)).catch(() => {});
      await db.delete(courierRequests).where(eq(courierRequests.id, requestId)).catch(() => {});
    }
    for (const id of createdItemIds.splice(0)) {
      await db.delete(items).where(eq(items.id, id)).catch(() => {});
    }
    for (const id of createdItemTypeIds.splice(0)) {
      await db.delete(itemTypes).where(eq(itemTypes.id, id)).catch(() => {});
    }
    for (const id of createdUserIds.splice(0)) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
  });

  function makeService(): CourierService {
    const repo = new DrizzleCourierRepository();
    return new CourierService(new DrizzleCourierUnitOfWork(), repo, repo, repo, repo, repo, createInventoryEngine());
  }

  async function seedTechnician(label: string) {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `p4w-${label}-${id.slice(0, 8)}`,
      email: `p4w-${label}-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: `P4 Writer Technician ${label}`,
      role: "technician",
    });
    createdUserIds.push(id);
    return id;
  }

  async function seedDeviceInCustody(ownerId: string, serialNumber: string) {
    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: `نوع-${itemTypeId.slice(0, 8)}`,
      nameEn: `Type-${itemTypeId.slice(0, 8)}`,
      category: "devices",
    });
    createdItemTypeIds.push(itemTypeId);

    const itemId = randomUUID();
    await db.insert(items).values({
      id: itemId,
      itemTypeId,
      serialNumber,
      barcode: `${serialNumber}-BAR`,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerId,
    });
    createdItemIds.push(itemId);

    // Its SIM, in the same custody (completeBody sends a complete pair).
    const simItemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: simItemTypeId,
      nameAr: `شريحة-${simItemTypeId.slice(0, 8)}`,
      nameEn: `Sim-${simItemTypeId.slice(0, 8)}`,
      category: "sim",
    });
    const simItemId = randomUUID();
    await db.insert(items).values({
      id: simItemId,
      itemTypeId: simItemTypeId,
      serialNumber: `${serialNumber}S`,
      barcode: `${serialNumber}S-BAR`,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerId,
    });
    createdItemIds.push(simItemId);
    return itemId;
  }

  function testSerial(prefix: string): string {
    return (prefix + randomUUID().slice(0, 10)).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  async function seedRequest(label: string) {
    const [row] = await db
      .insert(courierRequests)
      .values({
        customerName: `P4 Writer Customer ${label}`,
        incidentNumber: `P4W-${label}-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    createdRequestIds.push(row.id);
    return row.id as number;
  }

  async function seedPdfReport(requestId: number, uploadedBy: string, status = "pending") {
    const [row] = await db
      .insert(courierPdfReports)
      .values({
        requestId,
        fileName: "report.pdf",
        filePath: `/tmp/${randomUUID()}.pdf`,
        uploadedBy,
        status,
      })
      .returning();
    createdPdfIds.push(row.id);
    return row.id as number;
  }

  function completeBody(serial: string, technicianUsername: string) {
    return {
      devices: [{ sn: serial, sim_serial: `${serial}S`, technician_code: technicianUsername }],
      deliveryDate: "2026-07-12",
      time: "17:53",
      paperRoll: "Yes",
    };
  }

  it("1. assignRequestItems: fresh execution row is PENDING_DEDUCTION, not NULL", async () => {
    const tech = await seedTechnician("assign");
    const requestId = await seedRequest("assign");
    const service = makeService();

    await service.assignRequestItems(requestId, [{ itemType: "POS", quantity: 1 }], tech);

    const [row] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(row.custodyClosureStatus).toBe("PENDING_DEDUCTION");
  });

  it("2. acceptRequest: fresh execution row is PENDING_DEDUCTION, not NULL", async () => {
    const tech = await seedTechnician("accept");
    const requestId = await seedRequest("accept");
    const service = makeService();

    await service.acceptRequest(requestId, tech);

    const [row] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(row.custodyClosureStatus).toBe("PENDING_DEDUCTION");
  });

  it("3. confirmReceiving: fresh execution row is PENDING_DEDUCTION, not NULL", async () => {
    const tech = await seedTechnician("receive");
    const requestId = await seedRequest("receive");
    const service = makeService();
    // confirmReceiving requires at least one assigned request item to exist.
    await service.assignRequestItems(requestId, [{ itemType: "POS", quantity: 1 }], tech);
    await db.delete(courierExecutions).where(eq(courierExecutions.requestId, requestId));

    await service.confirmReceiving(requestId, tech);

    const [row] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(row.custodyClosureStatus).toBe("PENDING_DEDUCTION");
  });

  it("4. saveExecution fresh insert (incomplete status): PENDING_DEDUCTION, no completion signal emitted", async () => {
    const tech = await seedTechnician("save");
    const requestId = await seedRequest("save");
    const service = makeService();

    let completedEventSeen = false;
    const eventBus = EventBus.getInstance();
    const unsubscribe = eventBus.subscribe("ExecutionCompletedEvent", async (event: any) => {
      if (event.payload.requestId === requestId) completedEventSeen = true;
    });

    await service.saveExecution(requestId, { installationStatus: "In Progress" }, tech);

    const [row] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(row.custodyClosureStatus).toBe("PENDING_DEDUCTION");
    expect(completedEventSeen).toBe(false);
    unsubscribe?.();
  });

  it("5. applyPdfReport fresh insert (draft, pre-approval): PENDING_DEDUCTION", async () => {
    const tech = await seedTechnician("apply");
    const requestId = await seedRequest("apply");
    const pdfId = await seedPdfReport(requestId, tech);
    const service = makeService();

    await service.applyPdfReport(pdfId, requestId, { installationStatus: "In Progress" }, {}, tech);

    const [row] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(row.custodyClosureStatus).toBe("PENDING_DEDUCTION");
  });

  it("6. importRawRequests historical bulk import: RECONCILIATION_REQUIRED, not PENDING_DEDUCTION", async () => {
    const tech = await seedTechnician("import");
    const incident = `P4W-import-${randomUUID().slice(0, 8)}`;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Raw");
    sheet.addRow(["إسم العميل", "INCIDENT NUMBER", "TID", "SN", "Installation Status"]);
    sheet.addRow(["Excel Import Customer", incident, incident, `SN-${incident}`, "Installation Completed"]);
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;

    const service = makeService();
    // OPS-PERM-S0-B1-B.D2.OWNER: bulk import is Admin-only with a mandatory
    // per-batch targetRegionId. This test is about custody-closure status
    // derivation, not the region contract, so it seeds one real active
    // region and acts as admin purely to satisfy that contract.
    const [region] = await db
      .insert(regions)
      .values({ name: `P4W-import-region-${randomUUID().slice(0, 8)}` })
      .returning();
    try {
      await service.importRawRequests(buffer, tech, { role: "admin", regionId: null }, region.id);
    } finally {
      await db.delete(regions).where(eq(regions.id, region.id)).catch(() => {});
    }

    const [req] = await db.select().from(courierRequests).where(eq(courierRequests.incidentNumber, incident));
    expect(req).toBeTruthy();
    createdRequestIds.push(req.id);

    const [row] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, req.id));
    expect(row).toBeTruthy();
    expect(row.custodyClosureStatus).toBe("RECONCILIATION_REQUIRED");
  });

  // PRE-MULTI-DEVICE HARDENING (intentional change): completePdfReport
  // still inserts the row as PENDING_DEDUCTION, but its deduction now
  // commits in the same transaction, which then moves it to CLOSED_SUCCESS.
  it("7. completePdfReport: fresh row is inserted PENDING_DEDUCTION and commits CLOSED_SUCCESS with its deduction", async () => {
    const tech = await seedTechnician("complete");
    const serial = testSerial("P4WOK");
    await seedDeviceInCustody(tech, serial);
    const requestId = await seedRequest("complete");
    const pdfId = await seedPdfReport(requestId, tech);
    const service = makeService();

    await service.completePdfReport(pdfId, requestId, completeBody(serial, tech), tech);

    const [row] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    expect(row.custodyClosureStatus).toBe("CLOSED_SUCCESS");
  });
});
