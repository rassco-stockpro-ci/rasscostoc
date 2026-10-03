/**
 * OPS-REMED-E12 (E2) — real HTTP integration for the PDF-report approval
 * and rejection routes.
 *
 * Runs only via a real disposable Postgres test database (guarded below).
 * Only the authentication middleware is mocked (standard convention, e.g.
 * devices.routes.test.ts / serialized-items.routes.test.ts) — the
 * controller, service, unit-of-work, repository, and database are all
 * real. Proves the losing concurrent request receives a genuine HTTP 409
 * with a stable error code, not a service-level result described as
 * "equivalent" to one.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import { randomUUID } from "crypto";
import { db } from "@core/config/db";
import { users, itemTypes, items, courierRequests, courierPdfReports } from "@shared/schema";
import { registerCourierRoutes } from "./courier.routes";
import { errorHandler } from "../../../../core/errors/errorHandler";

// OPS-REMED-E12: this file lives under presentation/routes/, where the
// dependency-cruiser rule "controller-should-not-depend-on-repository-or-
// drizzle" forbids importing `drizzle-orm` (or `pg`) directly — confirmed
// via `npm run lint:architecture:strict`. `db.insert(...)` alone does not
// require importing any drizzle-orm operator (no `.where()` needed for
// inserts), so all fixtures below are seeded via plain inserts with fully
// randomized identifiers (UUIDs / random incident numbers) — no
// `eq`/`and`/`sql` import, no collision risk, and therefore deliberately
// NO afterEach cleanup (would require a `.where(eq(...))` condition,
// which is exactly the forbidden import). This disposable test database
// is torn down/recreated independently of this file's test hygiene.

const { currentUser } = vi.hoisted(() => ({
  currentUser: { id: "" as string, username: "e12-http-actor", role: "admin", regionId: null },
}));

vi.mock("@core/middlewares/auth.middleware", () => {
  return {
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = currentUser;
      next();
    },
    requireAuthOrInternal: (req: any, _res: any, next: any) => {
      req.user = currentUser;
      next();
    },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    requireSupervisor: (_req: any, _res: any, next: any) => next(),
    requireInternalService: (_req: any, _res: any, next: any) => next(),
  };
});

describe("OPS-REMED-E12 — real HTTP PDF approval/rejection conflict responses", () => {
  let app: express.Express;

  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database " +
          "(must contain 'test' in the database name). See scripts/test-database.mjs."
      );
    }
    app = express();
    app.use(express.json());
    registerCourierRoutes(app);
    app.use(errorHandler);
  });

  function testSerial(prefix: string): string {
    return (prefix + randomUUID().slice(0, 10)).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  async function seedActingUser(): Promise<{ id: string; username: string }> {
    const id = randomUUID();
    const username = `e12-http-${id.slice(0, 8)}`;
    await db.insert(users).values({
      id,
      username,
      email: `${username}@test.local`,
      password: "x",
      fullName: "E12 HTTP Actor",
      role: "admin",
    });
    currentUser.id = id;
    return { id, username };
  }

  async function seedDeviceInCustody(ownerId: string, serialNumber: string) {
    const itemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: `نوع-${itemTypeId.slice(0, 8)}`,
      nameEn: `Type-${itemTypeId.slice(0, 8)}`,
      category: "devices",
    });

    const itemId = randomUUID();
    await db.insert(items).values({
      id: itemId,
      itemTypeId,
      serialNumber,
      barcode: `${serialNumber}-BAR`,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerId,
    });

    const simItemTypeId = randomUUID();
    await db.insert(itemTypes).values({
      id: simItemTypeId,
      nameAr: `شريحة-${simItemTypeId.slice(0, 8)}`,
      nameEn: `Sim-${simItemTypeId.slice(0, 8)}`,
      category: "sim",
    });
    // Its SIM, in the same custody (the bodies below send a complete pair).
    await db.insert(items).values({
      id: randomUUID(),
      itemTypeId: simItemTypeId,
      serialNumber: `${serialNumber}S`,
      barcode: `${serialNumber}S-BAR`,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: ownerId,
    });
    return itemId;
  }

  async function seedRequest(label: string) {
    const [row] = await db
      .insert(courierRequests)
      .values({
        customerName: `E12 HTTP Customer ${label}`,
        incidentNumber: `E12-HTTP-${label}-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    return row.id;
  }

  /**
   * CLOSE REPORT-IDENTITY GATE (new): completePdfReport now requires the report's extracted
   * customer name and request number to match the request being closed. extractedJson here
   * mirrors the matched request exactly (same contract as update_rassco_extracted_json), so this
   * file keeps exercising its own OPS-REMED-E12 conflict-response assertions, not the new gate.
   * customerName is passed in by the caller (the exact string seedRequest just inserted) rather
   * than read back with `.where(eq(...))` — drizzle-orm operators are forbidden in this file's
   * directory (presentation/routes/), see the file header comment above.
   */
  async function seedPdfReport(requestId: number, uploadedBy: string, customerName: string) {
    const [row] = await db
      .insert(courierPdfReports)
      .values({
        requestId,
        fileName: "report.pdf",
        filePath: `/tmp/${randomUUID()}.pdf`,
        uploadedBy,
        status: "pending",
        extractedJson: JSON.stringify({
          retailer_name: { value: customerName, confidence: 95, source: "ai_engine" },
          request_number: { value: String(requestId), confidence: 95, source: "ai_engine" },
        }),
      })
      .returning();
    return row.id;
  }

  it(
    "19. POST /api/courier/pdf/:id/complete — losing concurrent request receives a real HTTP 409 with a stable error code",
    async () => {
      const actor = await seedActingUser();
      const serial = testSerial("E12HTTPOK");
      await seedDeviceInCustody(actor.id, serial);
      const requestId = await seedRequest("complete");
      const pdfId = await seedPdfReport(requestId, actor.id, "E12 HTTP Customer complete");

      const body = {
        request_id: requestId,
        devices: [{ sn: serial, sim_serial: `${serial}S`, technician_code: actor.username }],
        deliveryDate: "2026-07-12",
        time: "17:53",
        paperRoll: "Yes",
      };

      const [resA, resB] = await Promise.all([
        request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(body),
        request(app).post(`/api/courier/pdf/${pdfId}/complete`).send(body),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const conflictRes = resA.status === 409 ? resA : resB;
      expect(conflictRes.body.success).toBe(false);
      expect(conflictRes.body.code).toBe("PDF_REPORT_ALREADY_PROCESSED");
      // Never a raw PostgreSQL/internal field leaking to the client.
      expect(JSON.stringify(conflictRes.body)).not.toMatch(/relation|constraint|syntax error|pg_/i);
    },
    30000
  );

  it(
    "20. POST /api/courier/pdf/:id/reject — losing concurrent request receives a real HTTP 409",
    async () => {
      const actor = await seedActingUser();
      const requestId = await seedRequest("reject");
      const pdfId = await seedPdfReport(requestId, actor.id, "E12 HTTP Customer reject");

      const [resA, resB] = await Promise.all([
        request(app).post(`/api/courier/pdf/${pdfId}/reject`).send({ reasonCategory: "OTHER", notes: "x" }),
        request(app).post(`/api/courier/pdf/${pdfId}/reject`).send({ reasonCategory: "OTHER", notes: "y" }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const conflictRes = resA.status === 409 ? resA : resB;
      expect(conflictRes.body.success).toBe(false);
      expect(conflictRes.body.code).toBe("PDF_REPORT_ALREADY_PROCESSED");
    },
    30000
  );
});
