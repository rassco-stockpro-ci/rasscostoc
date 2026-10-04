/**
 * EXCEL-IMPORT PLACEHOLDER TAKEOVER — POST /api/courier/pdf/:id/complete on a request whose only
 * execution row is a placeholder written by importRawRequests (Excel ticket row: technician name /
 * ticket date / "Under Process", no serial, no work). Production: request 2300 (execution 1864) and
 * 218 others; every real close of them failed with DuplicateRequestApprovalError (409).
 *
 * The real close now takes the placeholder over (same row, reset, real data applied, old state in
 * the audit log) inside the close transaction. Anything that is not provably such a placeholder
 * keeps the existing duplicate protection. Also: the importer no longer creates placeholders.
 * Real HTTP + PostgreSQL; only auth is stubbed.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import ExcelJS from "exceljs";
import { randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users, itemTypes, items, regions, courierRequests, courierExecutions, courierPdfReports, courierAuditLogs,
  courierExecutionUnits, courierExecutionAttempts, custodyMovements, outboxEvents, inventoryDeductionCompletions,
} from "@shared/schema";
import { registerCourierRoutes } from "../presentation/routes/courier.routes";
import { errorHandler } from "@core/errors/errorHandler";
import { createInventoryEngine } from "../composition/courier.container";
import { CourierService } from "../application/courier.service";
import { DrizzleCourierRepository } from "../infrastructure/repositories/drizzle-courier.repository";
import { DrizzleCourierUnitOfWork } from "../infrastructure/repositories/DrizzleCourierUnitOfWork";

const { currentUser } = vi.hoisted(() => ({
  currentUser: { id: "" as string, username: "iph-actor", role: "admin", regionId: null },
}));
vi.mock("@core/middlewares/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => ((req.user = currentUser), next()),
  requireAuthOrInternal: (req: any, _res: any, next: any) => ((req.user = currentUser), next()),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireSupervisor: (_req: any, _res: any, next: any) => next(),
  requireInternalService: (_req: any, _res: any, next: any) => next(),
}));

const CUSTOMER = "بائع مشروبات ساخنة وباردة";

describe("EXCEL-IMPORT PLACEHOLDER TAKEOVER — completePdfReport (HTTP + PostgreSQL)", () => {
  let app: express.Express;
  let deviceTypeId: string;
  let simTypeId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    deviceTypeId = randomUUID();
    simTypeId = randomUUID();
    await db.insert(itemTypes).values([
      { id: deviceTypeId, nameAr: `جهاز-${deviceTypeId.slice(0, 6)}`, nameEn: `IPH-POS-${deviceTypeId.slice(0, 6)}`, category: "devices" },
      { id: simTypeId, nameAr: `شريحة-${simTypeId.slice(0, 6)}`, nameEn: `IPH-SIM-${simTypeId.slice(0, 6)}`, category: "sim" },
    ]);
    app = express();
    app.use(express.json());
    registerCourierRoutes(app);
    app.use(errorHandler);
  });

  const serial = (p: string) => (p + randomUUID().replace(/-/g, "").slice(0, 10)).toUpperCase();

  async function seedUser(label: string) {
    const id = randomUUID();
    const username = `iph-${label}-${id.slice(0, 6)}`;
    await db.insert(users).values({ id, username, email: `${username}@test.local`, password: "x", fullName: `IPH ${label}`, role: "admin" });
    return { id, username, fullName: `IPH ${label}` };
  }

  async function actAs(label: string) {
    const u = await seedUser(label);
    currentUser.id = u.id;
    currentUser.username = u.username;
    return u;
  }

  async function seedCustody(ownerId: string) {
    const sn = serial("IPHD");
    const deviceId = randomUUID(), simId = randomUUID();
    await db.insert(items).values({ id: deviceId, itemTypeId: deviceTypeId, serialNumber: sn, barcode: `${sn}-BAR`, status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: ownerId });
    await db.insert(items).values({ id: simId, itemTypeId: simTypeId, serialNumber: `${sn}S`, barcode: `${sn}S-BAR`, status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: ownerId });
    return { sn, simSn: `${sn}S`, deviceId, simId };
  }

  /** The request the importer created (its creator = the importing admin). */
  async function seedImportedRequest(importerId: string) {
    const [row] = await db
      .insert(courierRequests)
      .values({ customerName: CUSTOMER, incidentNumber: `IPH-${randomUUID().slice(0, 10)}`, date: "2026-09-22", tecName: "Zidan Hizam_Neoleap", createdBy: importerId })
      .returning();
    return row!;
  }

  /** Exactly the row the pre-fix importRawRequests wrote for a ticket-only Excel row (execution 1864's shape). */
  async function seedPlaceholder(req: { id: number; createdAt: Date | null; createdBy: string | null }, over: Record<string, unknown> = {}) {
    const at = req.createdAt ?? new Date();
    const [row] = await db
      .insert(courierExecutions)
      .values({
        requestId: req.id,
        installationStatus: "Under Process",
        salesTechnician: "Zidan Hizam_Neoleap",
        deliveryDate: "2026-09-22",
        enteredBy: req.createdBy,
        enteredAt: at,
        updatedAt: at,
        custodyClosureStatus: "RECONCILIATION_REQUIRED",
        ...over,
      })
      .returning();
    return row!;
  }

  async function seedReport(requestId: number, uploadedBy: string) {
    const json = JSON.stringify({
      date: { value: "2026-10-01", confidence: 80, source: "ai_engine" },
      time: { value: "21:46:52", confidence: 80, source: "ai_engine" },
      transaction_date: "2026-10-01", transaction_time: "21:46:52", date_source: "receipt",
      request_number: { value: String(requestId), confidence: 95, source: "ai_engine" },
      retailer_name: { value: CUSTOMER, confidence: 95, source: "ai_engine" },
      devices: [], extraction_source: "ai_engine",
    });
    const [row] = await db
      .insert(courierPdfReports)
      .values({ fileName: "iph.pdf", filePath: `/tmp/${randomUUID()}.pdf`, uploadedBy, status: "pending", extractedJson: json, requestId })
      .returning();
    return row!.id as number;
  }

  const body = (requestId: number, c: { sn: string; simSn: string }, username: string) => ({
    request_id: requestId, devices: [{ sn: c.sn, sim_serial: c.simSn, technician_code: username }],
    deliveryDate: "2026-10-01", time: "21:46", paperRoll: "Yes",
  });
  const complete = (pdfId: number, b: Record<string, unknown>) => request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(b);

  async function snapshot(requestId: number, itemIds: string[]) {
    const execs = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    const itemRows = await db.select().from(items).where(inArray(items.id, itemIds));
    return {
      execs,
      exec: execs[0] ?? null,
      delivered: itemRows.filter((r) => r.status === "DELIVERED" && !r.currentOwnerId).length,
      movements: (await db.select().from(custodyMovements).where(inArray(custodyMovements.itemId, itemIds))).length,
      units: await db.select().from(courierExecutionUnits).where(eq(courierExecutionUnits.requestId, requestId)),
      completions: await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, requestId)),
      events: (await db.select().from(outboxEvents).where(eq(outboxEvents.eventName, "ExecutionCompletedEvent")))
        .filter((e) => (e.payload as any)?.requestId === requestId),
      audit: await db.select().from(courierAuditLogs).where(and(eq(courierAuditLogs.tableName, "executions"), eq(courierAuditLogs.recordId, requestId))),
    };
  }

  async function placeholderScenario(label: string) {
    const importer = await seedUser(`importer-${label}`);
    const req = await seedImportedRequest(importer.id);
    const placeholder = await seedPlaceholder(req);
    const actor = await actAs(`tech-${label}`);
    const custody = await seedCustody(actor.id);
    const pdfId = await seedReport(req.id, actor.id);
    return { importer, req, placeholder, actor, custody, pdfId };
  }

  // ── takeover ──────────────────────────────────────────────────────────────────────────────
  it("1. a real close of an import placeholder succeeds: same row taken over, CLOSED_SUCCESS, device + SIM deducted, unit created", async () => {
    const s = await placeholderScenario("one");
    const res = await complete(s.pdfId, body(s.req.id, s.custody, s.actor.username));
    expect(res.status).toBe(200);

    const snap = await snapshot(s.req.id, [s.custody.deviceId, s.custody.simId]);
    expect(snap.execs).toHaveLength(1);
    expect(snap.exec!.id).toBe(s.placeholder.id); // taken over, not a second row
    expect(snap.exec!.version).toBe(2);
    expect(snap.exec!.custodyClosureStatus).toBe("CLOSED_SUCCESS");
    expect(snap.exec!.sn).toBe(s.custody.sn);
    expect(snap.exec!.simSerial).toBe(s.custody.simSn);
    expect(snap.delivered).toBe(2); // device + SIM both deducted
    expect(snap.movements).toBe(2);
    expect(snap.units).toHaveLength(1);
    expect(snap.units[0]).toMatchObject({ deviceSerial: s.custody.sn, simSerial: s.custody.simSn });
    expect(snap.completions).toHaveLength(1);
    expect(snap.events).toHaveLength(1);
    const [pdf] = await db.select().from(courierPdfReports).where(eq(courierPdfReports.id, s.pdfId));
    expect(pdf!.status).toBe("applied");
  });

  it("2. Excel leftovers do not survive: the row is what a fresh insert would be; identity is the closing technician's", async () => {
    const s = await placeholderScenario("fresh");
    expect((await complete(s.pdfId, body(s.req.id, s.custody, s.actor.username))).status).toBe(200);
    const [exec] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, s.req.id));
    expect(exec!.enteredBy).toBe(s.actor.id);
    expect(exec!.technicianCode).toBe(s.actor.username);
    expect(exec!.salesTechnician).toBe(s.actor.fullName); // not "Zidan Hizam_Neoleap" from Excel
    expect(exec!.deliveryDate).toBe("2026-10-01"); // the close's date, not the ticket's 2026-09-22
    expect(exec!.installationStatus).not.toBe("Under Process");
  });

  it("3. the placeholder's old state is kept in the audit log, written by the closing actor", async () => {
    const s = await placeholderScenario("audit");
    expect((await complete(s.pdfId, body(s.req.id, s.custody, s.actor.username))).status).toBe(200);
    const snap = await snapshot(s.req.id, [s.custody.deviceId, s.custody.simId]);
    const takeover = snap.audit.filter((a) => a.action === "import_placeholder_takeover");
    expect(takeover).toHaveLength(1);
    expect(takeover[0]!.changedBy).toBe(s.actor.id);
    expect(takeover[0]!.newValue).toContain(`#${s.pdfId}`);
    const old = JSON.parse(takeover[0]!.oldValue!);
    expect(old).toMatchObject({ id: s.placeholder.id, installationStatus: "Under Process", salesTechnician: "Zidan Hizam_Neoleap", deliveryDate: "2026-09-22", custodyClosureStatus: "RECONCILIATION_REQUIRED", version: 1 });
    expect(snap.audit.map((a) => a.action)).toContain("create");
  });

  it("4. a placeholder whose only audit is an earlier REJECTED close (verification_failed, like request 2304) is still taken over", async () => {
    const s = await placeholderScenario("rejected-before");
    await db.insert(courierAuditLogs).values({ tableName: "executions", recordId: s.req.id, fieldName: "status", action: "verification_failed", changedBy: s.actor.id, newValue: "rejected" });
    expect((await complete(s.pdfId, body(s.req.id, s.custody, s.actor.username))).status).toBe(200);
  });

  it("5. several placeholders on different requests are each taken over independently", async () => {
    const a = await placeholderScenario("multi-a");
    const ra = await complete(a.pdfId, body(a.req.id, a.custody, a.actor.username));
    const b = await placeholderScenario("multi-b");
    const rb = await complete(b.pdfId, body(b.req.id, b.custody, b.actor.username));
    expect([ra.status, rb.status]).toEqual([200, 200]);
    for (const s of [a, b]) {
      const snap = await snapshot(s.req.id, [s.custody.deviceId, s.custody.simId]);
      expect(snap.exec!.id).toBe(s.placeholder.id);
      expect(snap.exec!.custodyClosureStatus).toBe("CLOSED_SUCCESS");
      expect(snap.completions).toHaveLength(1);
    }
  });

  // ── concurrency + retry ───────────────────────────────────────────────────────────────────
  it("6. two different reports closing the same placeholder at once -> exactly one succeeds, one execution, one deduction", async () => {
    const s = await placeholderScenario("race");
    const pdf2 = await seedReport(s.req.id, s.actor.id);
    const results = await Promise.all([
      complete(s.pdfId, body(s.req.id, s.custody, s.actor.username)),
      complete(pdf2, body(s.req.id, s.custody, s.actor.username)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const snap = await snapshot(s.req.id, [s.custody.deviceId, s.custody.simId]);
    expect(snap.execs).toHaveLength(1);
    expect(snap.completions).toHaveLength(1);
    expect(snap.events).toHaveLength(1);
    expect(snap.units).toHaveLength(1);
    expect(snap.movements).toBe(2);
    const reports = await db.select().from(courierPdfReports).where(inArray(courierPdfReports.id, [s.pdfId, pdf2]));
    expect(reports.map((r) => r.status).sort()).toEqual(["applied", "pending"]); // the loser's claim rolled back
  }, 30000);

  it("7. retry after a successful takeover: the same report again and a new report are both refused, still one deduction", async () => {
    const s = await placeholderScenario("retry");
    expect((await complete(s.pdfId, body(s.req.id, s.custody, s.actor.username))).status).toBe(200);
    expect((await complete(s.pdfId, body(s.req.id, s.custody, s.actor.username))).status).toBe(409);
    // fresh devices still in custody, so the refusal comes from the duplicate protection itself
    // (with the already-delivered ones the custody guard would refuse first, with 422)
    const fresh = await seedCustody(s.actor.id);
    const pdf2 = await seedReport(s.req.id, s.actor.id);
    const again = await complete(pdf2, body(s.req.id, fresh, s.actor.username));
    expect(again.status).toBe(409);
    expect(again.body.message).toContain("تعارض اعتماد");
    expect((await snapshot(s.req.id, [fresh.deviceId, fresh.simId])).delivered).toBe(0);
    const snap = await snapshot(s.req.id, [s.custody.deviceId, s.custody.simId]);
    expect(snap.execs).toHaveLength(1);
    expect(snap.completions).toHaveLength(1);
    expect(snap.events).toHaveLength(1);
    expect(snap.audit.filter((a) => a.action === "import_placeholder_takeover")).toHaveLength(1);
  });

  // ── real executions stay protected ───────────────────────────────────────────────────────
  it("8. a real execution already closed by an earlier report -> a second report is still refused (409), nothing changes", async () => {
    const actor = await actAs("real-closed");
    const req = await seedImportedRequest(actor.id);
    const first = await seedCustody(actor.id);
    expect((await complete(await seedReport(req.id, actor.id), body(req.id, first, actor.username))).status).toBe(200);
    const [before] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, req.id));
    const second = await seedCustody(actor.id);
    const res = await complete(await seedReport(req.id, actor.id), body(req.id, second, actor.username));
    expect(res.status).toBe(409);
    const [after] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, req.id));
    expect(after).toEqual(before);
    expect((await snapshot(req.id, [second.deviceId, second.simId])).delivered).toBe(0);
  });

  const NOT_A_PLACEHOLDER: [string, (ctx: { req: any; actor: any; importer: any }) => Promise<void>, Record<string, unknown>][] = [
    ["live Under Process execution (PENDING_DEDUCTION, created by a live path)", async () => {}, { custodyClosureStatus: "PENDING_DEDUCTION" }],
    ["created by someone other than the request's creator", async () => {}, { enteredBy: "__actor__" }],
    ["created long after the request (not in the import step)", async () => {}, { __late: true }],
    ["modified after creation (version 2)", async () => {}, { version: 2 }],
    ["carries a device serial (historical evidence)", async () => {}, { sn: "HIST-SN-1" }],
    ["carries a SIM serial (historical evidence)", async () => {}, { simSerial: "8996600000000000001" }],
    ["marked Installation Completed", async () => {}, { installationStatus: "Installation Completed" }],
    ["a technician recorded an execution attempt", async ({ req, actor }) => {
      await db.insert(courierExecutionAttempts).values({ requestId: req.id, status: "FAILED", enteredBy: actor.id });
    }, {}],
    ["has a real audit entry (create)", async ({ req, actor }) => {
      await db.insert(courierAuditLogs).values({ tableName: "executions", recordId: req.id, action: "create", changedBy: actor.id });
    }, {}],
    ["another report was already applied to the request", async ({ req, actor }) => {
      await db.insert(courierPdfReports).values({ fileName: "old.pdf", filePath: `/tmp/${randomUUID()}.pdf`, uploadedBy: actor.id, status: "applied", requestId: req.id });
    }, {}],
  ];

  it.each(NOT_A_PLACEHOLDER)("9. NOT taken over — %s -> 409, row untouched, no deduction", async (_label, extra, over) => {
    const importer = await seedUser("np-importer");
    const req = await seedImportedRequest(importer.id);
    const actor = await actAs("np-tech");
    const fields: Record<string, unknown> = { ...over };
    if (fields.enteredBy === "__actor__") fields.enteredBy = actor.id;
    if (fields.__late) {
      delete fields.__late;
      const late = new Date((req.createdAt ?? new Date()).getTime() + 10 * 60 * 1000);
      fields.enteredAt = late;
      fields.updatedAt = late;
    }
    const existing = await seedPlaceholder(req, fields);
    await extra({ req, actor, importer });
    const custody = await seedCustody(actor.id);

    const res = await complete(await seedReport(req.id, actor.id), body(req.id, custody, actor.username));

    expect(res.status).toBe(409);
    const [after] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, req.id));
    expect(after).toEqual(existing);
    const snap = await snapshot(req.id, [custody.deviceId, custody.simId]);
    expect(snap.delivered).toBe(0);
    expect(snap.completions).toHaveLength(0);
    expect(snap.audit.filter((a) => a.action === "import_placeholder_takeover")).toHaveLength(0);
  });

  // ── the importer no longer creates placeholders ───────────────────────────────────────────
  it("10. importRawRequests: ticket-only rows get no execution; rows with real completion evidence still do", async () => {
    const admin = await seedUser("excel-admin");
    const [region] = await db.insert(regions).values({ name: `IPH-region-${randomUUID().slice(0, 8)}` }).returning();
    const tag = randomUUID().slice(0, 8);
    const inc = (k: string) => `IPH-IMP-${k}-${tag}`;
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Raw");
    sheet.addRow(["إسم العميل", "INCIDENT NUMBER", "TID", "SN", "Tec Name", "Sales Technician", "Delivery Date", "Installation Status"]);
    sheet.addRow([CUSTOMER, inc("ticket"), inc("ticket"), null, "Zidan Hizam_Neoleap", "Zidan Hizam_Neoleap", "2026-09-22", "Under Process"]);
    sheet.addRow([CUSTOMER, inc("tech"), inc("tech"), null, null, "Zidan Hizam_Neoleap", null, null]);
    sheet.addRow([CUSTOMER, inc("notdone"), inc("notdone"), null, "Zidan", "Zidan", "2026-09-22", "Not Completed"]);
    sheet.addRow([CUSTOMER, inc("serial"), inc("serial"), `SN-${tag}`, "Zidan", "Zidan", "2026-09-22", "Under Process"]);
    sheet.addRow([CUSTOMER, inc("done"), inc("done"), null, "Zidan", "Zidan", "2026-09-22", "Installation Completed"]);
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    const repo = new DrizzleCourierRepository();
    const service = new CourierService(new DrizzleCourierUnitOfWork(), repo, repo, repo, repo, repo, createInventoryEngine());
    try {
      await service.importRawRequests(buffer, admin.id, { role: "admin", regionId: null }, region!.id);
    } finally {
      await db.delete(regions).where(eq(regions.id, region!.id)).catch(() => {});
    }

    const execOf = async (k: string) => {
      const [r] = await db.select().from(courierRequests).where(eq(courierRequests.incidentNumber, inc(k)));
      expect(r, `request ${k} imported`).toBeTruthy();
      const [e] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, r!.id));
      return { r: r!, e: e ?? null };
    };
    const ticket = await execOf("ticket");
    expect(ticket.e).toBeNull(); // technician + date + Under Process = a ticket, not an installation
    expect(ticket.r).toMatchObject({ customerName: CUSTOMER, tecName: "Zidan Hizam_Neoleap" }); // request data kept
    expect((await execOf("tech")).e).toBeNull(); // technician name alone
    expect((await execOf("notdone")).e).toBeNull(); // "Not Completed" is no longer read as completed
    const withSerial = await execOf("serial");
    expect(withSerial.e).toMatchObject({ sn: `SN-${tag}`, custodyClosureStatus: "RECONCILIATION_REQUIRED" });
    const done = await execOf("done");
    expect(done.e).toMatchObject({ installationStatus: "Installation Completed", custodyClosureStatus: "RECONCILIATION_REQUIRED" });
  });
});
