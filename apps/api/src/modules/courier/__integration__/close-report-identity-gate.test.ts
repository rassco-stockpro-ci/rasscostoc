/**
 * CLOSE REPORT-IDENTITY GATE — POST /api/courier/pdf/:id/complete refuses a close (no deduction, no
 * CLOSED_SUCCESS, no outbox event, nothing written except one audit row) only on checks RASSCO has
 * a TRUSTED source for: does the report's claimed customer name and request number match the
 * request actually being closed. Real HTTP + PostgreSQL; only auth is stubbed.
 *
 * Scope boundary: this proves ONLY Request Number + Customer Name match. It does not claim to
 * validate every field of the form — Date/Time, Terminal ID, TID and the rest stay governed by
 * their own existing contracts.
 *
 * Receipt date/time are deliberately NOT enforced here — see receipt-datetime-extraction.test.ts
 * (pure Validation-layer proof) and CloseReportIdentityGuard: RASSCO has no trusted field for the
 * installation/visit date or time (courier_requests.date is the ticket's CREATION date — verified
 * against Production, e.g. request 2301's ticket date 2026-09-22, installed days/weeks later —
 * and courier_executions.time/delivery_date are this very close operation's own output, empty on
 * virtually every closed execution in Production history). That match status is UNVERIFIED, by
 * design, not a gap: test 11 below is the explicit regression proof that a missing receipt
 * date/time never blocks a close.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@core/config/db";
import { users, itemTypes, items, courierRequests, courierExecutions, courierPdfReports, courierAuditLogs } from "@shared/schema";
import { registerCourierRoutes } from "../presentation/routes/courier.routes";
import { errorHandler } from "@core/errors/errorHandler";

const { currentUser } = vi.hoisted(() => ({
  currentUser: { id: "" as string, username: "cig-actor", role: "admin", regionId: null },
}));
vi.mock("@core/middlewares/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => ((req.user = currentUser), next()),
  requireAuthOrInternal: (req: any, _res: any, next: any) => ((req.user = currentUser), next()),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireSupervisor: (_req: any, _res: any, next: any) => next(),
  requireInternalService: (_req: any, _res: any, next: any) => next(),
}));

describe("CLOSE REPORT-IDENTITY GATE — completePdfReport (HTTP + PostgreSQL)", () => {
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
      { id: deviceTypeId, nameAr: `جهاز-${deviceTypeId.slice(0, 6)}`, nameEn: `CIG-POS-${deviceTypeId.slice(0, 6)}`, category: "devices" },
      { id: simTypeId, nameAr: `شريحة-${simTypeId.slice(0, 6)}`, nameEn: `CIG-SIM-${simTypeId.slice(0, 6)}`, category: "sim" },
    ]);
    app = express();
    app.use(express.json());
    registerCourierRoutes(app);
    app.use(errorHandler);
  });

  function serial(prefix: string): string {
    return (prefix + randomUUID().replace(/-/g, "").slice(0, 10)).toUpperCase();
  }

  async function seedActingUser() {
    const id = randomUUID();
    const username = `cig-${id.slice(0, 8)}`;
    await db.insert(users).values({ id, username, email: `${username}@test.local`, password: "x", fullName: "CIG Actor", role: "admin" });
    currentUser.id = id;
    return { id, username };
  }

  async function seedDeviceInCustody(ownerId: string, sn: string) {
    await db.insert(items).values({ id: randomUUID(), itemTypeId: deviceTypeId, serialNumber: sn, barcode: `${sn}-BAR`, status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: ownerId });
    await db.insert(items).values({ id: randomUUID(), itemTypeId: simTypeId, serialNumber: `${sn}S`, barcode: `${sn}S-BAR`, status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: ownerId });
  }

  async function seedRequest(overrides: Partial<{ customerName: string | null; retailerName: string | null; incidentNumber: string; tid: string; terminalId: string }> = {}) {
    const [row] = await db
      .insert(courierRequests)
      .values({
        customerName: overrides.customerName === undefined ? "متجر الاختبار" : overrides.customerName,
        retailerName: overrides.retailerName ?? null,
        incidentNumber: overrides.incidentNumber ?? `CIG-${randomUUID().slice(0, 10)}`,
        tid: overrides.tid ?? null,
        terminalId: overrides.terminalId ?? null,
        date: "2026-09-22", // the TICKET's creation date — never read by this gate (see file header)
      })
      .returning();
    return row!.id as number;
  }

  function extractedJson(opts: { retailerName?: string | null; requestNumber?: string | number | null; date?: string | null; time?: string | null }): string {
    return JSON.stringify({
      date: { value: opts.date ?? null, confidence: opts.date ? 93 : 0, source: "ai_engine" },
      time: { value: opts.time ?? null, confidence: opts.time ? 93 : 0, source: "ai_engine" },
      transaction_date: opts.date ?? null,
      transaction_time: opts.time ?? null,
      request_number: { value: opts.requestNumber != null ? String(opts.requestNumber) : null, confidence: 95, source: "ai_engine" },
      retailer_name: { value: opts.retailerName ?? null, confidence: 95, source: "ai_engine" },
      devices: [],
      extraction_source: "ai_engine",
    });
  }

  async function seedPdfReport(json: string, uploadedBy: string) {
    const [row] = await db
      .insert(courierPdfReports)
      .values({ fileName: "report.pdf", filePath: `/tmp/${randomUUID()}.pdf`, uploadedBy, status: "pending", extractedJson: json })
      .returning();
    return row!.id as number;
  }

  /** The exact body shape courier-pdf-review.tsx sends (deliveryDate/time are never checked by this gate). */
  function completeBody(requestId: number, sn: string, username: string, overrides: Record<string, unknown> = {}) {
    return { request_id: requestId, devices: [{ sn, sim_serial: `${sn}S`, technician_code: username }], deliveryDate: "2026-07-12", time: "17:53", paperRoll: "Yes", ...overrides };
  }

  async function execFor(requestId: number) {
    const [row] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    return row ?? null;
  }

  /** The verification-failure audit rows written for this request (the one write a rejection is allowed to make). */
  async function rejectionAuditFor(requestId: number) {
    return db
      .select()
      .from(courierAuditLogs)
      .where(and(eq(courierAuditLogs.tableName, "executions"), eq(courierAuditLogs.recordId, requestId), eq(courierAuditLogs.action, "verification_failed")));
  }

  // ── 1. Request Number مطابق + Customer Name مطابق -> PASS ───────────────────────────────────
  it("1. matching customer name and request number -> 200, deduction runs, CLOSED_SUCCESS, no rejection audit", async () => {
    const actor = await seedActingUser();
    const sn = serial("CIGOK");
    await seedDeviceInCustody(actor.id, sn);
    const requestId = await seedRequest({ customerName: "متجر الأمانة" });
    const pdfId = await seedPdfReport(extractedJson({ date: "2026-07-12", time: "17:55:43", retailerName: "متجر الأمانة", requestNumber: requestId }), actor.id);

    const res = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username));

    expect(res.status).toBe(200);
    expect((await execFor(requestId))?.custodyClosureStatus).toBe("CLOSED_SUCCESS");
    expect(await rejectionAuditFor(requestId)).toHaveLength(0);
  });

  // ── 2. Request Number مختلف -> BLOCK + لا خصم ────────────────────────────────────────────────
  it("2. the report's extracted request number does not match the request being closed -> 422 REQUEST_NUMBER_MISMATCH, nothing written but the rejection audit", async () => {
    const actor = await seedActingUser();
    const sn = serial("CIGRN");
    await seedDeviceInCustody(actor.id, sn);
    const requestId = await seedRequest({ customerName: "متجر الأمانة" });
    const wrongRequestId = await seedRequest({ customerName: "متجر آخر" });
    const pdfId = await seedPdfReport(extractedJson({ retailerName: "متجر الأمانة", requestNumber: wrongRequestId }), actor.id);

    const res = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("REQUEST_NUMBER_MISMATCH");
    expect(await execFor(requestId)).toBeNull();
    const audit = await rejectionAuditFor(requestId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ fieldName: "status", changedBy: actor.id });
    expect(audit[0].newValue).toContain("رقم الطلب");
  });

  // ── 2b. request number matching the request's TID (not its id) is accepted ─────────────────
  it("2b. a request number matching the request's TID (not its id) is accepted, same as the bot's own matching", async () => {
    const actor = await seedActingUser();
    const sn = serial("CIGTID");
    await seedDeviceInCustody(actor.id, sn);
    const tid = `TID${randomUUID().slice(0, 8)}`;
    const requestId = await seedRequest({ customerName: "متجر الأمانة", tid });
    const pdfId = await seedPdfReport(extractedJson({ retailerName: "متجر الأمانة", requestNumber: tid }), actor.id);

    const res = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username));
    expect(res.status).toBe(200);
  });

  // ── 3 & 4. Customer Name مطابق، ومع اختلاف مسافات فقط -> PASS بعد normalization ─────────────
  it("3/4. customer name differing only by extra/collapsed whitespace still matches after normalization", async () => {
    const actor = await seedActingUser();
    const sn = serial("CIGWS");
    await seedDeviceInCustody(actor.id, sn);
    const requestId = await seedRequest({ customerName: "مؤسسة أحمد علي" });
    // extra/irregular whitespace on the report's side, same words
    const pdfId = await seedPdfReport(extractedJson({ retailerName: "مؤسسة  أحمد   علي", requestNumber: requestId }), actor.id);

    const res = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username));
    expect(res.status).toBe(200);
  });

  // ── 5. Customer Name مختلف فعليًا -> BLOCK + لا خصم (never fuzzy-matched) ───────────────────
  it("5. a genuinely different customer name is rejected, never fuzzy-matched -> 422 CUSTOMER_MISMATCH", async () => {
    const actor = await seedActingUser();
    const sn = serial("CIGCM");
    await seedDeviceInCustody(actor.id, sn);
    const requestId = await seedRequest({ customerName: "مؤسسة أحمد علي" });
    const pdfId = await seedPdfReport(extractedJson({ retailerName: "مؤسسة أحمد صالح", requestNumber: requestId }), actor.id);

    const res = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("CUSTOMER_MISMATCH");
    expect(await execFor(requestId)).toBeNull();
    const audit = await rejectionAuditFor(requestId);
    expect(audit).toHaveLength(1);
    expect(audit[0].newValue).toContain("اسم العميل");
  });

  // ── 6. Customer Name ناقص من PDF -> BLOCK ───────────────────────────────────────────────────
  it("6. a missing/empty customer name on the report is treated as a mismatch, never guessed -> 422 CUSTOMER_MISMATCH", async () => {
    const actor = await seedActingUser();
    const sn = serial("CIGCN");
    await seedDeviceInCustody(actor.id, sn);
    const requestId = await seedRequest({ customerName: "متجر الأمانة" });
    const pdfId = await seedPdfReport(extractedJson({ retailerName: null, requestNumber: requestId }), actor.id);

    const res = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("CUSTOMER_MISMATCH");
  });

  // ── 7. Request Number ناقص -> BLOCK ─────────────────────────────────────────────────────────
  it("7. a missing/empty request number on the report is treated as a mismatch, never guessed -> 422 REQUEST_NUMBER_MISMATCH", async () => {
    const actor = await seedActingUser();
    const sn = serial("CIGRM");
    await seedDeviceInCustody(actor.id, sn);
    const requestId = await seedRequest({ customerName: "متجر الأمانة" });
    const pdfId = await seedPdfReport(extractedJson({ retailerName: "متجر الأمانة", requestNumber: null }), actor.id);

    const res = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("REQUEST_NUMBER_MISMATCH");
    expect(await execFor(requestId)).toBeNull();
  });

  // ── 8. مطابقة العميل عبر retailer name عندما يكون ذلك هو الحقل المرجعي الصحيح ──────────────
  it("8. the request has no customerName but a matching retailerName -> customer check passes via retailerName", async () => {
    const actor = await seedActingUser();
    const sn = serial("CIGRET");
    await seedDeviceInCustody(actor.id, sn);
    const requestId = await seedRequest({ customerName: null, retailerName: "متجر عبر Retailer Name" });
    const pdfId = await seedPdfReport(extractedJson({ retailerName: "متجر عبر Retailer Name", requestNumber: requestId }), actor.id);

    const res = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username));
    expect(res.status).toBe(200);
  });

  // ── 9. Retry بعد تصحيح البيانات -> PASS ─────────────────────────────────────────────────────
  it("9. a refused close, retried with the corrected request number, succeeds (fully retriable, no partial write)", async () => {
    const actor = await seedActingUser();
    const sn = serial("CIGRT");
    await seedDeviceInCustody(actor.id, sn);
    const requestId = await seedRequest({ customerName: "متجر الأمانة" });
    const pdfId = await seedPdfReport(extractedJson({ retailerName: "متجر الأمانة", requestNumber: 999999999 }), actor.id);

    const bad = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username));
    expect(bad.status).toBe(422);
    expect(await execFor(requestId)).toBeNull();

    await db.update(courierPdfReports).set({ extractedJson: extractedJson({ retailerName: "متجر الأمانة", requestNumber: requestId }) }).where(eq(courierPdfReports.id, pdfId));
    const good = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username));
    expect(good.status).toBe(200);
    expect((await execFor(requestId))?.custodyClosureStatus).toBe("CLOSED_SUCCESS");
  });

  // ── 10. Multi-Device/Multi-SIM regression -> PASS ───────────────────────────────────────────
  it("10. two devices, each with its own SIM, close exactly as before once customer/request-number match", async () => {
    const actor = await seedActingUser();
    const snA = serial("CIGMDA");
    const snB = serial("CIGMDB");
    await seedDeviceInCustody(actor.id, snA);
    await seedDeviceInCustody(actor.id, snB);
    const requestId = await seedRequest({ customerName: "متجر الأمانة" });
    const pdfId = await seedPdfReport(extractedJson({ retailerName: "متجر الأمانة", requestNumber: requestId }), actor.id);

    const res = await request(app)
      .post(`/api/courier/pdf/${pdfId}/complete`)
      .send({
        request_id: requestId,
        devices: [
          { sn: snA, sim_serial: `${snA}S`, technician_code: actor.username },
          { sn: snB, sim_serial: `${snB}S`, technician_code: actor.username },
        ],
        deliveryDate: "2026-07-12",
        time: "17:55",
        paperRoll: "Yes",
      });

    expect(res.status).toBe(200);
    expect((await execFor(requestId))?.custodyClosureStatus).toBe("CLOSED_SUCCESS");
  });

  // ── 11. Date/Time = null لا يسبب regression في الإغلاق ──────────────────────────────────────
  it("11. a report with no extracted date/time at all still closes, since RASSCO has no trusted installation-date/time source to match against", async () => {
    const actor = await seedActingUser();
    const sn = serial("CIGDT");
    await seedDeviceInCustody(actor.id, sn);
    const requestId = await seedRequest({ customerName: "متجر الأمانة" });
    const pdfId = await seedPdfReport(extractedJson({ date: null, time: null, retailerName: "متجر الأمانة", requestNumber: requestId }), actor.id);

    const res = await request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(completeBody(requestId, sn, actor.username, { deliveryDate: "", time: "" }));

    expect(res.status).toBe(200);
    expect((await execFor(requestId))?.custodyClosureStatus).toBe("CLOSED_SUCCESS");
  });
});
