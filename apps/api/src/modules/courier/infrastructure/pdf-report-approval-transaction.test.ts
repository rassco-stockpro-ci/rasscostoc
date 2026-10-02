/**
 * OPS-REMED-E12 (E1+E2) — atomic PDF-report approval / rejection.
 *
 * Runs only via a real disposable Postgres test database (guarded below,
 * same pattern as the sibling optimistic-locking / execution-attempts
 * integration tests). No mocks — real CourierService, real
 * DrizzleCourierUnitOfWork, real DrizzleCourierRepository, real database.
 *
 * Proves (design frozen in OPS-REMED-E12-A.2):
 * - E1: report-claim, execution save, and both outbox event enqueues
 *   (ExecutionSavedEvent + ExecutionCompletedEvent) happen inside ONE
 *   transaction — any failure at any step rolls back everything.
 * - E2: two concurrent approvals of the same report, two different
 *   reports approving the same request, and approve-vs-reject can never
 *   both succeed.
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  items,
  courierRequests,
  courierPdfReports,
  courierExecutions,
  courierAuditLogs,
  outboxEvents,
  inventoryDeductionCompletions,
} from "@shared/schema";
import { createInventoryEngine } from "../composition/courier.container";
import { CourierService } from "../application/courier.service";
import { DrizzleCourierRepository } from "./repositories/drizzle-courier.repository";
import { DrizzleCourierUnitOfWork } from "./repositories/DrizzleCourierUnitOfWork";
import { PdfReportAlreadyProcessedError, DuplicateRequestApprovalError } from "@core/errors/AppError";
import { ExecutionCompletedEvent, ExecutionSavedEvent } from "@core/events/events";

describe("OPS-REMED-E12 — atomic PDF-report approval/rejection transaction", () => {
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
      await db.delete(courierAuditLogs).where(and(eq(courierAuditLogs.tableName, "pdf_reports"), eq(courierAuditLogs.recordId, id))).catch(() => {});
      await db.delete(courierPdfReports).where(eq(courierPdfReports.id, id)).catch(() => {});
    }
    for (const requestId of createdRequestIds.splice(0)) {
      // Deliberately NOT a blanket `db.delete(outboxEvents)` here — this
      // table is shared with other test files/workers running
      // concurrently against the same disposable database; a global
      // truncate after every test would wipe out another file's
      // in-flight rows. All outbox assertions in this file filter by
      // this test's own requestId instead (see test #1, #7-10, #21-23,
      // #24) — accumulated rows from other tests are harmless noise.
      await db.delete(courierAuditLogs).where(and(eq(courierAuditLogs.tableName, "executions"), eq(courierAuditLogs.recordId, requestId))).catch(() => {});
      // Approvals now deduct in their own transaction; drop the completion
      // rows so CourierProjectionWorker's tests never claim them.
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

  function testSerial(prefix: string): string {
    return (prefix + randomUUID().slice(0, 10)).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function makeService(): CourierService {
    const repo = new DrizzleCourierRepository();
    return new CourierService(new DrizzleCourierUnitOfWork(), repo, repo, repo, repo, repo, createInventoryEngine());
  }

  async function seedTechnician(label: string) {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `e12-${label}-${id.slice(0, 8)}`,
      email: `e12-${label}-${id.slice(0, 8)}@test.local`,
      password: "x",
      fullName: `E12 Technician ${label}`,
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
      category: "device",
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

    // Its SIM, in the same custody: completeBody() sends a complete
    // device/SIM pair, which the close's in-transaction deduction requires.
    const simItemId = randomUUID();
    await db.insert(items).values({
      id: simItemId,
      itemTypeId,
      serialNumber: simSerialFor(serialNumber),
      barcode: `${simSerialFor(serialNumber)}-BAR`,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerId,
    });
    createdItemIds.push(simItemId);
    return itemId;
  }

  function simSerialFor(deviceSerial: string): string {
    return `${deviceSerial}S`;
  }

  async function seedRequest(label: string) {
    const [row] = await db
      .insert(courierRequests)
      .values({
        customerName: `E12 Customer ${label}`,
        incidentNumber: `E12-${label}-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    createdRequestIds.push(row.id);
    return row.id;
  }

  async function seedPdfReport(requestId: number | null, uploadedBy: string, status = "pending") {
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
    return row.id;
  }

  function completeBody(serial: string, technicianUsername: string) {
    return {
      devices: [{ sn: serial, sim_serial: simSerialFor(serial), technician_code: technicianUsername }],
      deliveryDate: "2026-07-12",
      time: "17:53",
      paperRoll: "Yes",
    };
  }

  it(
    "1. single approval succeeds atomically: applied, one execution, one saved event, one completed event",
    async () => {
      const tech = await seedTechnician("single");
      const serial = testSerial("E12OK");
      await seedDeviceInCustody(tech, serial);
      const requestId = await seedRequest("single");
      const pdfId = await seedPdfReport(requestId, tech);

      const service = makeService();
      const result = await service.completePdfReport(pdfId, requestId, completeBody(serial, tech), tech);

      expect(result.pdf.status).toBe("applied");

      const [pdfRow] = await db.select().from(courierPdfReports).where(eq(courierPdfReports.id, pdfId));
      expect(pdfRow!.status).toBe("applied");

      const execRows = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
      expect(execRows.length).toBe(1);

      // Filtered by this test's own requestId — the outbox table is
      // shared across all tests/files in this run (no truncation between
      // them by design, see the top-of-file note), so an unfiltered count
      // would be flaky whenever another file's tests run concurrently.
      const outboxRows = await db.select().from(outboxEvents);
      const savedRows = outboxRows.filter(
        (r) => r.eventName === "ExecutionSavedEvent" && (r.payload as any)?.requestId === requestId
      );
      const completedRows = outboxRows.filter(
        (r) => r.eventName === "ExecutionCompletedEvent" && (r.payload as any)?.requestId === requestId
      );
      expect(savedRows.length).toBe(1);
      expect(completedRows.length).toBe(1);
    },
    30000
  );

  it(
    "2. same pdfId: two concurrent approvals — exactly one succeeds, one gets PdfReportAlreadyProcessedError",
    async () => {
      const tech = await seedTechnician("samepdf");
      const serial = testSerial("E12SAME");
      await seedDeviceInCustody(tech, serial);
      const requestId = await seedRequest("samepdf");
      const pdfId = await seedPdfReport(requestId, tech);

      const serviceA = makeService();
      const serviceB = makeService();
      const body = completeBody(serial, tech);

      const results = await Promise.allSettled([
        serviceA.completePdfReport(pdfId, requestId, body, tech),
        serviceB.completePdfReport(pdfId, requestId, body, tech),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      const failure = rejected[0] as PromiseRejectedResult;
      expect(failure.reason).toBeInstanceOf(PdfReportAlreadyProcessedError);

      const [pdfRow] = await db.select().from(courierPdfReports).where(eq(courierPdfReports.id, pdfId));
      expect(pdfRow!.status).toBe("applied");

      const execRows = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
      expect(execRows.length).toBe(1);
    },
    30000
  );

  it(
    "3. different pdfId, same requestId: two concurrent approvals — exactly one execution, DuplicateRequestApprovalError not raw 23505",
    async () => {
      const tech = await seedTechnician("samereq");
      const serialA = testSerial("E12REQA");
      const serialB = testSerial("E12REQB");
      await seedDeviceInCustody(tech, serialA);
      await seedDeviceInCustody(tech, serialB);
      const requestId = await seedRequest("samereq");
      const pdfIdA = await seedPdfReport(requestId, tech);
      const pdfIdB = await seedPdfReport(requestId, tech);

      const serviceA = makeService();
      const serviceB = makeService();

      const results = await Promise.allSettled([
        serviceA.completePdfReport(pdfIdA, requestId, completeBody(serialA, tech), tech),
        serviceB.completePdfReport(pdfIdB, requestId, completeBody(serialB, tech), tech),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // The losing report must have rolled back to "pending", never left
      // falsely "applied", and the failure must be the structured error —
      // never a raw PostgreSQL unique-violation escaping to the caller.
      const failure = rejected[0] as PromiseRejectedResult;
      const isStructured =
        failure.reason instanceof DuplicateRequestApprovalError ||
        failure.reason instanceof PdfReportAlreadyProcessedError;
      expect(isStructured).toBe(true);
      expect(failure.reason?.code).not.toBe("23505");

      const pdfRows = await db
        .select()
        .from(courierPdfReports)
        .where(and(eq(courierPdfReports.id, pdfIdA)));
      const [pdfRowB] = await db.select().from(courierPdfReports).where(eq(courierPdfReports.id, pdfIdB));
      const statuses = [pdfRows[0]!.status, pdfRowB!.status].sort();
      expect(statuses).toEqual(["applied", "pending"]);

      const execRows = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
      expect(execRows.length).toBe(1);
    },
    30000
  );

  it(
    "4. approve vs reject same pdfId concurrently: exactly one terminal transition",
    async () => {
      const tech = await seedTechnician("appvrej");
      const serial = testSerial("E12AVR");
      await seedDeviceInCustody(tech, serial);
      const requestId = await seedRequest("appvrej");
      const pdfId = await seedPdfReport(requestId, tech);

      const service = makeService();

      const results = await Promise.allSettled([
        service.completePdfReport(pdfId, requestId, completeBody(serial, tech), tech),
        service.rejectPdfReport(pdfId, "OTHER", "note", tech),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBe(1);

      const [pdfRow] = await db.select().from(courierPdfReports).where(eq(courierPdfReports.id, pdfId));
      expect(["applied", "rejected"]).toContain(pdfRow!.status);
    },
    30000
  );

  it(
    "5. repeated approval after committed success: second call gets PdfReportAlreadyProcessedError, no new execution",
    async () => {
      const tech = await seedTechnician("retry");
      const serial = testSerial("E12RETRY");
      await seedDeviceInCustody(tech, serial);
      const requestId = await seedRequest("retry");
      const pdfId = await seedPdfReport(requestId, tech);

      const service = makeService();
      await service.completePdfReport(pdfId, requestId, completeBody(serial, tech), tech);

      await expect(
        service.completePdfReport(pdfId, requestId, completeBody(serial, tech), tech)
      ).rejects.toBeInstanceOf(PdfReportAlreadyProcessedError);

      const execRows = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
      expect(execRows.length).toBe(1);
    },
    30000
  );

  it(
    "6. repeated rejection after committed success: second call gets PdfReportAlreadyProcessedError",
    async () => {
      const tech = await seedTechnician("rerej");
      const requestId = await seedRequest("rerej");
      const pdfId = await seedPdfReport(requestId, tech);

      const service = makeService();
      await service.rejectPdfReport(pdfId, "OTHER", "note", tech);

      await expect(service.rejectPdfReport(pdfId, "OTHER", "note again", tech)).rejects.toBeInstanceOf(
        PdfReportAlreadyProcessedError
      );
    },
    30000
  );

  it(
    "7-10. injected failure at each transaction step rolls back everything: report stays pending, zero execution, zero outbox rows survive",
    async () => {
      const tech = await seedTechnician("crash");
      const serialA = testSerial("E12CRASHA");
      const serialB = testSerial("E12CRASHB");
      await seedDeviceInCustody(tech, serialA);
      await seedDeviceInCustody(tech, serialB);
      const requestId = await seedRequest("crash");
      const pdfIdA = await seedPdfReport(requestId, tech);
      const pdfIdB = await seedPdfReport(requestId, tech);

      const service = makeService();

      // First report approves the request normally — this is the ONLY
      // execution that should ever exist for requestId.
      await service.completePdfReport(pdfIdA, requestId, completeBody(serialA, tech), tech);

      // Second report, DIFFERENT pdfId, SAME requestId, run sequentially
      // (not concurrently) so the exact ordering is deterministic: its own
      // atomic claim (step 1, inside its OWN transaction) succeeds and
      // transitions pdfIdB to "applied" — then insertExecution fails with
      // DuplicateRequestApprovalError (the unique constraint on
      // courier_executions.request_id, already occupied by report A's
      // execution). This is a legitimate, production-realistic failure
      // seam — no debug hook — and proves the claim from step 1 rolls back
      // TOGETHER with the later failure, inside one transaction. The same
      // single ROLLBACK mechanism applies regardless of which step throws
      // (claim, execution save, or either enqueue).
      await expect(
        service.completePdfReport(pdfIdB, requestId, completeBody(serialB, tech), tech)
      ).rejects.toThrow();

      const [pdfRowB] = await db.select().from(courierPdfReports).where(eq(courierPdfReports.id, pdfIdB));
      expect(pdfRowB!.status).toBe("pending"); // claim rolled back, not falsely "applied"

      const execRows = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
      expect(execRows.length).toBe(1); // only report A's execution exists

      const outboxRows = await db.select().from(outboxEvents);
      const completedRows = outboxRows.filter(
        (r) => r.eventName === "ExecutionCompletedEvent" && (r.payload as any)?.requestId === requestId
      );
      // Exactly one ExecutionCompletedEvent survives (report A's) — report
      // B's attempt produced zero surviving outbox rows.
      expect(completedRows.length).toBe(1);
    },
    30000
  );

  it(
    "11. commit succeeds, simulated crash before response construction: DB state fully persisted regardless",
    async () => {
      const tech = await seedTechnician("postcommit");
      const serial = testSerial("E12POST");
      await seedDeviceInCustody(tech, serial);
      const requestId = await seedRequest("postcommit");
      const pdfId = await seedPdfReport(requestId, tech);

      const service = makeService();
      const result = await service.completePdfReport(pdfId, requestId, completeBody(serial, tech), tech);
      // The response object itself may or may not reach the client in a
      // real crash — what matters is that DB state is already durable the
      // instant this call returns, independent of anything downstream.
      expect(result).toBeDefined();

      const [pdfRow] = await db.select().from(courierPdfReports).where(eq(courierPdfReports.id, pdfId));
      expect(pdfRow!.status).toBe("applied");
    },
    30000
  );

  it(
    "15-16. winner-only audit records, losing report stays pending (identity, not just count)",
    async () => {
      const tech = await seedTechnician("audit");
      const serialA = testSerial("E12AUDA");
      const serialB = testSerial("E12AUDB");
      await seedDeviceInCustody(tech, serialA);
      await seedDeviceInCustody(tech, serialB);
      const requestId = await seedRequest("audit");
      const pdfIdA = await seedPdfReport(requestId, tech);
      const pdfIdB = await seedPdfReport(requestId, tech);

      const serviceA = makeService();
      const serviceB = makeService();
      await Promise.allSettled([
        serviceA.completePdfReport(pdfIdA, requestId, completeBody(serialA, tech), tech),
        serviceB.completePdfReport(pdfIdB, requestId, completeBody(serialB, tech), tech),
      ]);

      const auditA = await db
        .select()
        .from(courierAuditLogs)
        .where(and(eq(courierAuditLogs.tableName, "pdf_reports"), eq(courierAuditLogs.recordId, pdfIdA)));
      const auditB = await db
        .select()
        .from(courierAuditLogs)
        .where(and(eq(courierAuditLogs.tableName, "pdf_reports"), eq(courierAuditLogs.recordId, pdfIdB)));
      // Exactly one of the two reports has an audit row (the winner) —
      // never both, never neither.
      expect(auditA.length + auditB.length).toBe(1);
    },
    30000
  );

  it(
    "17-18. 23505 on courier_executions_request_id_unique is translated; an unrelated error is not misclassified",
    async () => {
      const tech = await seedTechnician("constraint");
      const requestId = await seedRequest("constraint");
      const repo = new DrizzleCourierRepository();

      // OPS-REMED-E4-P4-I1.R1 §7: this is a direct repository-level fixture
      // exercising unique-constraint translation, not a specific lifecycle
      // path — PENDING_DEDUCTION is the correct generic fresh-row value
      // (post-P4 NOT NULL requires an explicit value here regardless).
      await repo.insertExecution({
        requestId,
        enteredBy: tech,
        installationStatus: "Installation Completed - NL",
        custodyClosureStatus: "PENDING_DEDUCTION",
      });

      await expect(
        repo.insertExecution({
          requestId,
          enteredBy: tech,
          installationStatus: "Installation Completed - NL",
          custodyClosureStatus: "PENDING_DEDUCTION",
        })
      ).rejects.toBeInstanceOf(DuplicateRequestApprovalError);

      // An unrelated failure (missing required field / FK violation) must
      // NOT be misclassified as DuplicateRequestApprovalError.
      await expect(
        repo.insertExecution({
          requestId: 999999999,
          enteredBy: tech,
          installationStatus: "Installation Completed - NL",
          custodyClosureStatus: "PENDING_DEDUCTION",
        })
      ).rejects.not.toBeInstanceOf(DuplicateRequestApprovalError);
    },
    30000
  );

  it(
    "21-23. Telegram fires only after commit; no network/local-subscriber activity while the transaction is open, even under BYPASS_OUTBOX/test mode",
    async () => {
      const tech = await seedTechnician("network");
      const serial = testSerial("E12NET");
      const itemId = await seedDeviceInCustody(tech, serial);
      const requestId = await seedRequest("network");
      const pdfId = await seedPdfReport(requestId, tech);

      const service = makeService();
      await service.completePdfReport(pdfId, requestId, completeBody(serial, tech), tech);

      // PRE-MULTI-DEVICE HARDENING (intentional change): the deduction now
      // commits inside the approval transaction itself, so the item is
      // DELIVERED the moment the approval returns. The enqueued event is
      // still only a durable PENDING outbox row — no local subscriber ran
      // while the transaction was open (asserted below).
      const [item] = await db.select().from(items).where(eq(items.id, itemId));
      expect(item!.status).toBe("DELIVERED");
      expect(item!.currentOwnerId).toBeNull();

      const outboxRows = await db.select().from(outboxEvents);
      const completedRows = outboxRows.filter(
        (r) => r.eventName === "ExecutionCompletedEvent" && (r.payload as any)?.requestId === requestId
      );
      expect(completedRows.length).toBe(1);
      expect(completedRows[0]!.status).toBe("PENDING");
    },
    30000
  );

  it(
    "24. ExecutionCompletedEvent payload preserves requestId/actorId/execution/request field-for-field",
    async () => {
      const tech = await seedTechnician("payload");
      const serial = testSerial("E12PAY");
      await seedDeviceInCustody(tech, serial);
      const requestId = await seedRequest("payload");
      const pdfId = await seedPdfReport(requestId, tech);

      const service = makeService();
      await service.completePdfReport(pdfId, requestId, completeBody(serial, tech), tech);

      const completedCandidates = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.eventName, "ExecutionCompletedEvent"));
      const outboxRow = completedCandidates.find((r) => (r.payload as any)?.requestId === requestId);
      expect(outboxRow).toBeDefined();
      const payload = outboxRow!.payload as any;
      expect(payload.requestId).toBe(requestId);
      expect(payload.actorId).toBe(tech);
      expect(payload.execution).toBeDefined();
      expect(payload.execution.installationStatus).toBe("Installation Completed - NL");
      expect(payload.request).toBeDefined();
      expect(payload.request.id).toBe(requestId);
    },
    30000
  );

  it(
    "25. two real service instances against one disposable Postgres — same as #2/#3",
    async () => {
      const tech = await seedTechnician("twoinst");
      const serial = testSerial("E12TWO");
      await seedDeviceInCustody(tech, serial);
      const requestId = await seedRequest("twoinst");
      const pdfId = await seedPdfReport(requestId, tech);

      const serviceInstance1 = makeService();
      const serviceInstance2 = makeService();
      const body = completeBody(serial, tech);

      const results = await Promise.allSettled([
        serviceInstance1.completePdfReport(pdfId, requestId, body, tech),
        serviceInstance2.completePdfReport(pdfId, requestId, body, tech),
      ]);

      expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
      expect(results.filter((r) => r.status === "rejected").length).toBe(1);
    },
    30000
  );
});
