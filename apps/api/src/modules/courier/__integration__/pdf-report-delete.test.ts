/**
 * DELETE AN UPLOADED PDF REPORT SO IT CAN BE UPLOADED AGAIN — real HTTP routes against PostgreSQL.
 *
 *   DELETE /api/courier/pdf/:id  (admin only; an "applied" report is refused with 409)
 *     → the courier_pdf_reports row is gone, an audit row is written and a
 *       courier_pdf_deletion_tasks row is queued — all in one transaction
 *   POST /api/courier/pdf/deletion-tasks/claim            (internal service key only)
 *   POST /api/courier/pdf/deletion-tasks/:taskId/complete (internal service key only)
 *     → the installation bot deletes the Drive file and releases its dedupe hashes,
 *       then reports the outcome (retry, attempt cap, expired lease)
 *
 * Only requireAuth is stubbed (to choose the caller's role); requireAdmin and
 * requireInternalService are the real middleware.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@core/config/db";
import { users, courierRequests, courierPdfReports, courierPdfDeletionTasks, courierAuditLogs } from "@shared/schema";
import { registerCourierRoutes } from "../presentation/routes/courier.routes";
import { errorHandler } from "@core/errors/errorHandler";

const { currentUser } = vi.hoisted(() => ({
  currentUser: { id: "" as string, username: "pdfdel-actor", role: "admin", regionId: null as string | null },
}));
vi.mock("@core/middlewares/auth.middleware", async () => {
  const actual = await vi.importActual<typeof import("@core/middlewares/auth.middleware")>(
    "@core/middlewares/auth.middleware"
  );
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => ((req.user = { ...currentUser }), next()),
  };
});

const KEY = `pdfdel-key-${randomUUID()}`;
const previousKey = process.env.INTERNAL_SERVICE_KEY;

describe("Delete an uploaded PDF report (HTTP + PostgreSQL)", () => {
  let app: express.Express;
  let adminId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    process.env.INTERNAL_SERVICE_KEY = KEY;
    adminId = randomUUID();
    await db.insert(users).values({
      id: adminId,
      username: `pdfdel-admin-${adminId.slice(0, 8)}`,
      email: `pdfdel-${adminId.slice(0, 8)}@test.local`,
      password: "x",
      fullName: "PDF Delete Admin",
      role: "admin",
    });
    currentUser.id = adminId;
    app = express();
    app.use(express.json());
    registerCourierRoutes(app);
    app.use(errorHandler);
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = previousKey;
  });

  function asRole(role: string) {
    currentUser.role = role;
  }

  async function seedReport(status: string) {
    const [req] = await db
      .insert(courierRequests)
      .values({ customerName: "PDF delete", incidentNumber: `PDFDEL-${randomUUID().slice(0, 10)}` })
      .returning();
    const driveId = `drv${randomUUID().replace(/-/g, "")}`;
    const [row] = await db
      .insert(courierPdfReports)
      .values({
        requestId: req.id,
        fileName: `report-${driveId.slice(3, 9)}.pdf`,
        filePath: `https://drive.google.com/file/d/${driveId}/view?usp=drivesdk`,
        uploadedBy: adminId,
        status,
      })
      .returning();
    return row;
  }

  const reportRow = (id: number) => db.select().from(courierPdfReports).where(eq(courierPdfReports.id, id));
  const tasksFor = (id: number) =>
    db.select().from(courierPdfDeletionTasks).where(eq(courierPdfDeletionTasks.reportId, id));
  const bot = () => ({
    claim: () => request(app).post("/api/courier/pdf/deletion-tasks/claim").set("x-internal-service-key", KEY),
    complete: (taskId: number, body: unknown) =>
      request(app)
        .post(`/api/courier/pdf/deletion-tasks/${taskId}/complete`)
        .set("x-internal-service-key", KEY)
        .send(body as object),
  });

  /** Claims until the queue is empty, acknowledging each task as done (all tasks here belong to this file). */
  async function drainQueue() {
    for (let i = 0; i < 50; i++) {
      const res = await bot().claim();
      expect(res.status).toBe(200);
      if (!res.body.task) return;
      await bot().complete(res.body.task.id, { success: true });
    }
    throw new Error("queue did not drain");
  }

  // ── who may delete ─────────────────────────────────────────────────────
  it.each(["technician", "supervisor", "courier_supervisor", "warehouse", "viewer"])(
    "1. %s is refused with 403 and nothing changes",
    async (role) => {
      const report = await seedReport("pending");
      asRole(role);
      try {
        const res = await request(app).delete(`/api/courier/pdf/${report.id}`);
        expect(res.status).toBe(403);
      } finally {
        asRole("admin");
      }
      expect(await reportRow(report.id)).toHaveLength(1);
      expect(await tasksFor(report.id)).toHaveLength(0);
    }
  );

  // ── what gets deleted ──────────────────────────────────────────────────
  it.each(["pending", "rejected", "manual_review"])(
    "2. admin deletes a %s report: row gone, audit row and a PENDING Drive/hash cleanup task",
    async (status) => {
      const report = await seedReport(status);
      const res = await request(app).delete(`/api/courier/pdf/${report.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, id: report.id, status: "deleted" });

      expect(await reportRow(report.id)).toHaveLength(0);

      const [task, ...more] = await tasksFor(report.id);
      expect(more).toHaveLength(0);
      expect(task).toMatchObject({
        id: res.body.deletionTaskId,
        status: "PENDING",
        attempts: 0,
        driveUrl: report.filePath,
        fileName: report.fileName,
        requestedBy: adminId,
      });

      const audit = await db
        .select()
        .from(courierAuditLogs)
        .where(and(eq(courierAuditLogs.tableName, "pdf_reports"), eq(courierAuditLogs.recordId, report.id)));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: "delete", oldValue: status, changedBy: adminId });
      expect(audit[0].metadata).toMatchObject({
        fileName: report.fileName,
        driveUrl: report.filePath,
        requestId: report.requestId,
        deletionTaskId: task.id,
      });
    }
  );

  it("3. an approved and applied report is refused with 409 and stays exactly as it was", async () => {
    const report = await seedReport("applied");
    const res = await request(app).delete(`/api/courier/pdf/${report.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PDF_REPORT_APPLIED_CANNOT_DELETE");
    expect(await reportRow(report.id)).toEqual([report]);
    expect(await tasksFor(report.id)).toHaveLength(0);
  });

  it("4. unknown id → 404, malformed id → 400", async () => {
    expect((await request(app).delete("/api/courier/pdf/2147480000")).status).toBe(404);
    expect((await request(app).delete("/api/courier/pdf/abc")).status).toBe(400);
    expect((await request(app).delete("/api/courier/pdf/0")).status).toBe(400);
  });

  it("5. two concurrent deletes of the same report: one 200, one 404, exactly one cleanup task", async () => {
    const report = await seedReport("pending");
    const [a, b] = await Promise.all([
      request(app).delete(`/api/courier/pdf/${report.id}`),
      request(app).delete(`/api/courier/pdf/${report.id}`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(await tasksFor(report.id)).toHaveLength(1);
  });

  it("6. delete racing a reject: the report ends up deleted with exactly one cleanup task", async () => {
    const report = await seedReport("pending");
    const [del, rej] = await Promise.all([
      request(app).delete(`/api/courier/pdf/${report.id}`),
      request(app).post(`/api/courier/pdf/${report.id}/reject`).send({ reasonCategory: "OTHER", notes: "race" }),
    ]);
    // pending and rejected are both deletable, so the delete succeeds whichever runs first
    expect(del.status).toBe(200);
    expect([200, 404, 409]).toContain(rej.status);
    expect(await reportRow(report.id)).toHaveLength(0);
    expect(await tasksFor(report.id)).toHaveLength(1);
  });

  // ── the bot's side of the queue ────────────────────────────────────────
  it("7. claim/complete require the internal service key (no key or a wrong key → 401)", async () => {
    expect((await request(app).post("/api/courier/pdf/deletion-tasks/claim")).status).toBe(401);
    expect(
      (await request(app).post("/api/courier/pdf/deletion-tasks/claim").set("x-internal-service-key", "wrong")).status
    ).toBe(401);
    expect(
      (await request(app).post("/api/courier/pdf/deletion-tasks/1/complete").send({ success: true })).status
    ).toBe(401);
  });

  it("8. claim → lease; failure → retried; success → DONE; nothing left to claim", async () => {
    await drainQueue();
    const report = await seedReport("pending");
    const del = await request(app).delete(`/api/courier/pdf/${report.id}`);
    const taskId = del.body.deletionTaskId;

    const first = await bot().claim();
    expect(first.body.task).toMatchObject({
      id: taskId,
      reportId: report.id,
      driveUrl: report.filePath,
      status: "CLAIMED",
      attempts: 1,
    });
    expect(new Date(first.body.task.leasedUntil).getTime()).toBeGreaterThan(Date.now());

    // leased: a second poll does not get the same task
    expect((await bot().claim()).body.task).toBeNull();

    const failed = await bot().complete(taskId, { success: false, error: "drive 500" });
    expect(failed.status).toBe(200);
    expect(failed.body.task).toMatchObject({ status: "PENDING", lastError: "drive 500", leasedUntil: null });

    const second = await bot().claim();
    expect(second.body.task).toMatchObject({ id: taskId, attempts: 2, status: "CLAIMED" });

    const done = await bot().complete(taskId, { success: true });
    expect(done.body.task).toMatchObject({ status: "DONE", lastError: null });
    expect(done.body.task.completedAt).toBeTruthy();

    expect((await bot().claim()).body.task).toBeNull();
  });

  it("9. a crashed bot's expired lease is claimed again", async () => {
    await drainQueue();
    const report = await seedReport("pending");
    const taskId = (await request(app).delete(`/api/courier/pdf/${report.id}`)).body.deletionTaskId;
    expect((await bot().claim()).body.task.id).toBe(taskId);

    await db
      .update(courierPdfDeletionTasks)
      .set({ leasedUntil: new Date(Date.now() - 1000) })
      .where(eq(courierPdfDeletionTasks.id, taskId));

    const again = await bot().claim();
    expect(again.body.task).toMatchObject({ id: taskId, attempts: 2, status: "CLAIMED" });
    await bot().complete(taskId, { success: true });
  });

  it("10. after 5 attempts a failure is final (FAILED) and is never claimed again", async () => {
    await drainQueue();
    const report = await seedReport("pending");
    const taskId = (await request(app).delete(`/api/courier/pdf/${report.id}`)).body.deletionTaskId;
    await bot().claim();
    await db.update(courierPdfDeletionTasks).set({ attempts: 5 }).where(eq(courierPdfDeletionTasks.id, taskId));

    const res = await bot().complete(taskId, { success: false, error: "permission denied" });
    expect(res.body.task).toMatchObject({ status: "FAILED", lastError: "permission denied" });
    expect((await bot().claim()).body.task).toBeNull();
  });

  it("11. complete: success must be a boolean (400); unknown task → 404", async () => {
    expect((await bot().complete(1, {})).status).toBe(400);
    expect((await bot().complete(1, { success: "yes" })).status).toBe(400);
    expect((await bot().complete(2147480000, { success: true })).status).toBe(404);
  });
});
