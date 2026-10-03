/**
 * MULTI-DEVICE / MULTI-SIM — installation units (migration 0060), through the
 * real HTTP routes against real PostgreSQL. Only authentication is stubbed.
 *
 * Every close here is checked in the database: execution_units rows, request
 * items INSTALLED and linked to their unit, every device and SIM DELIVERED,
 * one completion row, CLOSED_SUCCESS, audit, one outbox event carrying the
 * units — or, for a refused close, nothing at all.
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  items,
  courierRequests,
  courierRequestItems,
  courierExecutions,
  courierExecutionUnits,
  courierAuditLogs,
  courierPdfReports,
  custodyMovements,
  outboxEvents,
  inventoryDeductionCompletions,
} from "@shared/schema";
import { registerCourierRoutes } from "../presentation/routes/courier.routes";
import { errorHandler } from "@core/errors/errorHandler";
import { SerializedItemsAdapter } from "../infrastructure/adapters/SerializedItemsAdapter";
import { MAX_CLOSE_UNITS } from "../domain/execution-unit";

const { currentUser } = vi.hoisted(() => ({
  currentUser: { id: "" as string, username: "md-actor", role: "admin", regionId: null },
}));
vi.mock("@core/middlewares/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => ((req.user = currentUser), next()),
  requireAuthOrInternal: (req: any, _res: any, next: any) => ((req.user = currentUser), next()),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireSupervisor: (_req: any, _res: any, next: any) => next(),
  requireInternalService: (_req: any, _res: any, next: any) => next(),
}));

const COMPLETED = "Installation Completed - NL";

describe("Multi-Device / Multi-SIM installation units (HTTP + PostgreSQL)", () => {
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
      { id: deviceTypeId, nameAr: "جهاز", nameEn: `MD-POS-${deviceTypeId.slice(0, 6)}`, category: "devices" },
      { id: simTypeId, nameAr: "شريحة", nameEn: `MD-SIM-${simTypeId.slice(0, 6)}`, category: "sim" },
    ]);
    app = express();
    app.use(express.json());
    registerCourierRoutes(app);
    app.use(errorHandler);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.COURIER_REQUIRE_EXPLICIT_PAIRING;
  });

  // ── fixtures ────────────────────────────────────────────────────────────
  const serial = (p: string) => (p + randomUUID().replace(/-/g, "").slice(0, 10)).toUpperCase();

  async function seedTech(label: string) {
    const id = randomUUID();
    const username = `md-${label}-${id.slice(0, 8)}`;
    await db.insert(users).values({ id, username, email: `${username}@test.local`, password: "x", fullName: `MD ${label}`, role: "technician" });
    currentUser.id = id;
    return { id, username };
  }
  async function seedItem(ownerId: string | null, sn: string, kind: "device" | "sim", status = "RECEIVED_BY_TECHNICIAN") {
    const id = randomUUID();
    await db.insert(items).values({ id, itemTypeId: kind === "sim" ? simTypeId : deviceTypeId, serialNumber: sn, barcode: `${sn}-B`, status, currentOwnerId: ownerId });
    return id;
  }
  async function seedRequest() {
    const [row] = await db.insert(courierRequests).values({ customerName: "MD", incidentNumber: `MD-${randomUUID().slice(0, 8)}` }).returning();
    return row!.id as number;
  }
  /** n devices + n SIMs held by the technician. */
  async function seedUnits(techId: string, n: number) {
    const out: { device: string; sim: string; deviceId: string; simId: string }[] = [];
    for (let i = 0; i < n; i++) {
      const device = serial("MDD"), sim = serial("MDS");
      out.push({ device, sim, deviceId: await seedItem(techId, device, "device"), simId: await seedItem(techId, sim, "sim") });
    }
    return out;
  }
  const close = (requestId: number, body: Record<string, unknown>) =>
    request(app).post(`/api/courier/executions/${requestId}`).send({ installationStatus: COMPLETED, ...body });

  // ── database snapshot ───────────────────────────────────────────────────
  async function snapshot(requestId: number, itemIds: string[]) {
    const itemRows = itemIds.length ? await db.select().from(items).where(inArray(items.id, itemIds)) : [];
    const [exec] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    const units = await db.select().from(courierExecutionUnits).where(eq(courierExecutionUnits.requestId, requestId)).orderBy(courierExecutionUnits.unitNo);
    const links = await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, requestId));
    const events = (await db.select().from(outboxEvents).where(eq(outboxEvents.eventName, "ExecutionCompletedEvent"))).filter(
      (e) => (e.payload as any)?.requestId === requestId
    );
    return {
      delivered: itemRows.filter((r) => r.status === "DELIVERED" && !r.currentOwnerId).length,
      inCustody: itemRows.filter((r) => r.status !== "DELIVERED" && r.currentOwnerId).length,
      movements: itemIds.length ? (await db.select().from(custodyMovements).where(inArray(custodyMovements.itemId, itemIds))).length : 0,
      closure: exec?.custodyClosureStatus ?? null,
      execution: exec ?? null,
      units,
      links,
      completions: await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, requestId)),
      events,
      audit: (await db.select().from(courierAuditLogs).where(eq(courierAuditLogs.recordId, requestId))).map((a) => a.action),
    };
  }

  async function expectClosed(requestId: number, set: Awaited<ReturnType<typeof seedUnits>>, opts: { pairing?: string } = {}) {
    const ids = set.flatMap((u) => [u.deviceId, u.simId]);
    const s = await snapshot(requestId, ids);
    expect(s.closure).toBe("CLOSED_SUCCESS");
    expect(s.delivered).toBe(ids.length);
    expect(s.movements).toBe(ids.length);
    expect(s.units).toHaveLength(set.length);
    s.units.forEach((u, i) => {
      expect(u).toMatchObject({
        unitNo: i + 1,
        deviceItemId: set[i]!.deviceId,
        deviceSerial: set[i]!.device,
        simItemId: set[i]!.simId,
        simSerial: set[i]!.sim,
        simWaived: false,
        pairingSource: opts.pairing ?? "EXPLICIT",
      });
    });
    expect(s.links).toHaveLength(ids.length);
    for (const link of s.links) {
      expect(link.status).toBe("INSTALLED");
      const unit = s.units.find((u) => u.id === link.executionUnitId);
      expect(unit).toBeDefined();
      expect([unit!.deviceSerial, unit!.simSerial]).toContain(link.serialNumber ?? link.simSerial);
      expect(link.itemId).toBe(link.serialNumber ? unit!.deviceItemId : unit!.simItemId);
    }
    expect(s.completions).toHaveLength(1);
    expect(s.completions[0]!.serializedItemCount).toBe(ids.length);
    expect(s.events).toHaveLength(1);
    expect(((s.events[0]!.payload as any).execution.units as any[]).length).toBe(set.length);
    expect(s.audit).toContain("INVENTORY_DEDUCTED");
    expect(s.execution!.sn).toBe(set[0]!.device); // legacy readers: unit 1
    return s;
  }

  async function expectUntouched(requestId: number, ids: string[]) {
    const s = await snapshot(requestId, ids);
    expect(s).toMatchObject({ delivered: 0, inCustody: ids.length, movements: 0, closure: null, units: [], completions: [], events: [] });
    expect(s.links).toHaveLength(0);
  }

  // ── N units ─────────────────────────────────────────────────────────────
  for (const n of [1, 2, 3, 5, MAX_CLOSE_UNITS]) {
    it(`${n} device(s) + ${n} SIM(s) via units[]: one atomic close, ${n} unit(s), everything installed and deducted`, async () => {
      const tech = await seedTech(`n${n}`);
      const set = await seedUnits(tech.id, n);
      const requestId = await seedRequest();
      const res = await close(requestId, { units: set.map((u, i) => ({ deviceSerial: u.device, simSerial: u.sim, tid: `T${i + 1}` })) });
      expect(res.status).toBe(200);
      const s = await expectClosed(requestId, set);
      expect(s.units.map((u) => u.tid)).toEqual(set.map((_, i) => `T${i + 1}`));
      // the response carries the units too
      expect(res.body.execution.units).toHaveLength(n);
    }, 60000);
  }

  it(`${MAX_CLOSE_UNITS + 1} units → 422 UNIT_LIMIT_EXCEEDED, nothing written`, async () => {
    const tech = await seedTech("limit");
    const requestId = await seedRequest();
    const units = Array.from({ length: MAX_CLOSE_UNITS + 1 }, () => ({ deviceSerial: serial("MDX"), simSerial: serial("MDY") }));
    const res = await close(requestId, { units });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("UNIT_LIMIT_EXCEEDED");
    await expectUntouched(requestId, []);
  });

  // ── unit rules ──────────────────────────────────────────────────────────
  it("device without SIM, declared (simWaived) → closes; the unit records the waiver", async () => {
    const tech = await seedTech("waived");
    const device = serial("MDD");
    const deviceId = await seedItem(tech.id, device, "device");
    const requestId = await seedRequest();
    const res = await close(requestId, { units: [{ deviceSerial: device, simWaived: true }] });
    expect(res.status).toBe(200);
    const s = await snapshot(requestId, [deviceId]);
    expect(s.closure).toBe("CLOSED_SUCCESS");
    expect(s.units).toHaveLength(1);
    expect(s.units[0]).toMatchObject({ deviceItemId: deviceId, simItemId: null, simSerial: null, simWaived: true, pairingSource: "EXPLICIT" });
  });

  const rejections: Array<[string, string, (d: string[], s: string[]) => unknown[]]> = [
    ["device without SIM, not declared", "UNIT_SIM_MISSING_NOT_WAIVED", (d) => [{ deviceSerial: d[0] }]],
    ["SIM without device", "UNIT_SIM_WITHOUT_DEVICE", (_d, s) => [{ simSerial: s[0] }]],
    ["duplicate device", "UNIT_DUPLICATE_DEVICE", (d, s) => [{ deviceSerial: d[0], simSerial: s[0] }, { deviceSerial: d[0], simSerial: s[1] }]],
    ["duplicate device under another spelling", "UNIT_DUPLICATE_DEVICE", (d, s) => [{ deviceSerial: d[0], simSerial: s[0] }, { deviceSerial: d[0]!.toLowerCase(), simSerial: s[1] }]],
    ["duplicate SIM", "UNIT_DUPLICATE_SIM", (d, s) => [{ deviceSerial: d[0], simSerial: s[0] }, { deviceSerial: d[1], simSerial: s[0] }]],
    ["a SIM in the device position", "UNIT_ROLE_MISMATCH", (_d, s) => [{ deviceSerial: s[0], simSerial: s[1] }]],
    ["a device in the SIM position", "UNIT_ROLE_MISMATCH", (d) => [{ deviceSerial: d[0], simSerial: d[1] }]],
  ];
  for (const [label, code, build] of rejections) {
    it(`${label} → 422 ${code}, nothing written`, async () => {
      const tech = await seedTech("rule");
      const set = await seedUnits(tech.id, 2);
      const requestId = await seedRequest();
      const res = await close(requestId, { units: build(set.map((u) => u.device), set.map((u) => u.sim)) });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(code);
      await expectUntouched(requestId, set.flatMap((u) => [u.deviceId, u.simId]));
    });
  }

  // ── custody ─────────────────────────────────────────────────────────────
  it("custody: another technician's SIM → 422; IN_TRANSIT → closes; WAREHOUSE → 422", async () => {
    const tech = await seedTech("cust");
    const other = randomUUID();
    await db.insert(users).values({ id: other, username: `md-o-${other.slice(0, 8)}`, email: `${other}@t.local`, password: "x", fullName: "Other", role: "technician" });
    currentUser.id = tech.id;

    const d1 = serial("MDD"), s1 = serial("MDS");
    const ids1 = [await seedItem(tech.id, d1, "device"), await seedItem(other, s1, "sim")];
    const r1 = await seedRequest();
    expect((await close(r1, { units: [{ deviceSerial: d1, simSerial: s1 }] })).status).toBe(422);
    const s1snap = await snapshot(r1, ids1);
    expect(s1snap).toMatchObject({ delivered: 0, closure: null, units: [] });

    const d2 = serial("MDD"), s2 = serial("MDS");
    await seedItem(tech.id, d2, "device", "IN_TRANSIT");
    await seedItem(tech.id, s2, "sim", "IN_TRANSIT");
    const r2 = await seedRequest();
    expect((await close(r2, { units: [{ deviceSerial: d2, simSerial: s2 }] })).status).toBe(200);
    expect((await snapshot(r2, [])).closure).toBe("CLOSED_SUCCESS");

    const d3 = serial("MDD"), s3 = serial("MDS");
    const ids3 = [await seedItem(tech.id, d3, "device"), await seedItem(tech.id, s3, "sim", "WAREHOUSE")];
    const r3 = await seedRequest();
    expect((await close(r3, { units: [{ deviceSerial: d3, simSerial: s3 }] })).status).toBe(422);
    expect((await snapshot(r3, ids3)).delivered).toBe(0);
  });

  // ── atomicity ───────────────────────────────────────────────────────────
  it("3 units, the third invalid (unknown device) → 422, units 1-2 untouched", async () => {
    const tech = await seedTech("mixed");
    const set = await seedUnits(tech.id, 3);
    const requestId = await seedRequest();
    const units = set.map((u) => ({ deviceSerial: u.device, simSerial: u.sim }));
    units[2]!.deviceSerial = serial("NOPE");
    const res = await close(requestId, { units });
    expect(res.status).toBe(422);
    await expectUntouched(requestId, set.flatMap((u) => [u.deviceId, u.simId]));
  });

  it("3 units, the item locked LAST fails at scan-out after the five before it were scanned out → full rollback", async () => {
    const tech = await seedTech("partial");
    const set = await seedUnits(tech.id, 3);
    const requestId = await seedRequest();
    // The engine scans items in item-id order (the lock order): fail the highest id.
    const all = set.flatMap((u) => [
      { id: u.deviceId, serial: u.device },
      { id: u.simId, serial: u.sim },
    ]);
    const last = all.reduce((x, y) => (y.id > x.id ? y : x));
    const original = SerializedItemsAdapter.prototype.scanOut;
    const scanned: string[] = [];
    vi.spyOn(SerializedItemsAdapter.prototype, "scanOut").mockImplementation(async function (this: any, ...args: any[]) {
      if (args[1] === last.serial) throw new Error("injected scan-out failure on the last item");
      scanned.push(args[1]);
      return (original as any).apply(this, args);
    });
    const res = await close(requestId, { units: set.map((u) => ({ deviceSerial: u.device, simSerial: u.sim })) });
    expect(res.status).toBe(503);
    expect(scanned).toHaveLength(5); // five really were scanned out before the failure
    await expectUntouched(requestId, all.map((x) => x.id));
  });

  // ── idempotency / concurrency ───────────────────────────────────────────
  it("the same close twice in a row → 200 then 422; one execution, one unit set, one deduction", async () => {
    const tech = await seedTech("twice");
    const set = await seedUnits(tech.id, 2);
    const requestId = await seedRequest();
    const body = { units: set.map((u) => ({ deviceSerial: u.device, simSerial: u.sim })) };
    expect((await close(requestId, body)).status).toBe(200);
    expect((await close(requestId, body)).status).toBe(422);
    const s = await expectClosed(requestId, set);
    expect(s.units).toHaveLength(2);
  }, 30000);

  it("the same close twice at once → exactly one succeeds, one deduction", async () => {
    const tech = await seedTech("race");
    const set = await seedUnits(tech.id, 2);
    const requestId = await seedRequest();
    const body = { units: set.map((u) => ({ deviceSerial: u.device, simSerial: u.sim })) };
    const results = await Promise.all([close(requestId, body), close(requestId, body)]);
    expect(results.map((r) => r.status).filter((st) => st === 200)).toHaveLength(1);
    await expectClosed(requestId, set);
  }, 30000);

  it("the same two pairs on two requests at once, listed in opposite order → one close wins, no deadlock, no double deduction", async () => {
    const tech = await seedTech("pair-race");
    const set = await seedUnits(tech.id, 2);
    const [ra, rb] = [await seedRequest(), await seedRequest()];
    const forward = { units: set.map((u) => ({ deviceSerial: u.device, simSerial: u.sim })) };
    const backward = { units: [...set].reverse().map((u) => ({ deviceSerial: u.device, simSerial: u.sim })) };
    const results = await Promise.all([close(ra, forward), close(rb, backward)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([422, 503]).toContain(statuses[1]);
    const ids = set.flatMap((u) => [u.deviceId, u.simId]);
    const [sa, sb] = [await snapshot(ra, ids), await snapshot(rb, ids)];
    expect(sa.movements).toBe(4); // movements counted per item, shared across both snapshots
    expect(sa.completions.length + sb.completions.length).toBe(1);
    expect(sa.units.length + sb.units.length).toBe(2);
  }, 30000);

  // ── backward compatibility ──────────────────────────────────────────────
  it("legacy single sn + simSerial → one EXPLICIT unit", async () => {
    const tech = await seedTech("legacy1");
    const set = await seedUnits(tech.id, 1);
    const requestId = await seedRequest();
    expect((await close(requestId, { sn: set[0]!.device, simSerial: set[0]!.sim })).status).toBe(200);
    const s = await expectClosed(requestId, set);
    expect(s.audit).not.toContain("UNIT_PAIRING_INFERRED");
  });

  it("legacy lists (2 devices + 2 SIMs) → paired by order, LEGACY_INFERRED, audited", async () => {
    const tech = await seedTech("legacy2");
    const set = await seedUnits(tech.id, 2);
    const requestId = await seedRequest();
    const res = await close(requestId, { sn: set[0]!.device, simSerial: set[0]!.sim, deviceSerials: set.map((u) => u.device), simSerials: set.map((u) => u.sim) });
    expect(res.status).toBe(200);
    const s = await expectClosed(requestId, set, { pairing: "LEGACY_INFERRED" });
    expect(s.audit).toContain("UNIT_PAIRING_INFERRED");
  });

  it("transition period closed (COURIER_REQUIRE_EXPLICIT_PAIRING=true): legacy lists → 422 PAIRING_REQUIRED; units[] still close", async () => {
    process.env.COURIER_REQUIRE_EXPLICIT_PAIRING = "true";
    const tech = await seedTech("legacy3");
    const set = await seedUnits(tech.id, 2);
    const requestId = await seedRequest();
    const legacy = await close(requestId, { deviceSerials: set.map((u) => u.device), simSerials: set.map((u) => u.sim) });
    expect(legacy.status).toBe(422);
    expect(legacy.body.code).toBe("PAIRING_REQUIRED");
    await expectUntouched(requestId, set.flatMap((u) => [u.deviceId, u.simId]));
    expect((await close(requestId, { units: set.map((u) => ({ deviceSerial: u.device, simSerial: u.sim })) })).status).toBe(200);
    await expectClosed(requestId, set);
  });

  // ── other channels ──────────────────────────────────────────────────────
  it("PDF approval devices[] (the Telegram bot's payload) with 3 cards → 3 EXPLICIT units with their TIDs", async () => {
    const tech = await seedTech("pdf");
    const set = await seedUnits(tech.id, 3);
    const requestId = await seedRequest();
    const [pdf] = await db.insert(courierPdfReports).values({ requestId, fileName: "r.pdf", filePath: `/tmp/${randomUUID()}.pdf`, uploadedBy: tech.id, status: "pending", extractedJson: JSON.stringify({ retailer_name: { value: "MD" }, request_number: { value: String(requestId) } }) }).returning();
    const res = await request(app).post(`/api/courier/pdf/${pdf!.id}/complete`).send({
      request_id: requestId,
      devices: set.map((u, i) => ({ sn: u.device, sim_serial: u.sim, tid: `TID-${i + 1}`, technician_code: tech.username })),
      deliveryDate: "2026-10-02",
      time: "10:00",
      paperRoll: "Yes",
    });
    expect(res.status).toBe(200);
    const s = await expectClosed(requestId, set);
    expect(s.units.map((u) => u.tid)).toEqual(["TID-1", "TID-2", "TID-3"]);
  }, 30000);

  it("mobile SUCCESS attempt with units[] (2) → 201, 2 units", async () => {
    const tech = await seedTech("mobile");
    const set = await seedUnits(tech.id, 2);
    const requestId = await seedRequest();
    await db.insert(courierExecutions).values({ requestId, installationStatus: "ACCEPTED", technicianCode: tech.username, enteredBy: tech.id, custodyClosureStatus: "PENDING_DEDUCTION" });
    const res = await request(app).post(`/api/courier/requests/${requestId}/execution-attempts`).send({
      status: "SUCCESS",
      units: set.map((u) => ({ deviceSerial: u.device, simSerial: u.sim })),
    });
    expect(res.status).toBe(201);
    await expectClosed(requestId, set);
  }, 30000);

  it("search by the SECOND device's and the THIRD SIM's serial finds the request (not only unit 1)", async () => {
    const tech = await seedTech("search");
    const set = await seedUnits(tech.id, 3);
    const requestId = await seedRequest();
    expect((await close(requestId, { units: set.map((u) => ({ deviceSerial: u.device, simSerial: u.sim })) })).status).toBe(200);

    for (const term of [set[0]!.device, set[1]!.device, set[2]!.sim]) {
      const res = await request(app).get("/api/courier/requests").query({ q: term });
      expect(res.status).toBe(200);
      const rows: any[] = res.body.rows ?? res.body.data ?? res.body;
      expect(rows.map((r) => r.id), `search "${term}"`).toContain(requestId);
    }
  }, 30000);

  it("fewer units than the request's assigned devices → closes with a UNIT_COUNT_MISMATCH audit warning", async () => {
    const tech = await seedTech("count");
    const set = await seedUnits(tech.id, 1);
    const requestId = await seedRequest();
    await db.insert(courierRequestItems).values([
      { requestId, itemType: "POS", quantity: 1, status: "PENDING_RECEIPT" },
      { requestId, itemType: "POS", quantity: 1, status: "PENDING_RECEIPT" },
    ]);
    const res = await close(requestId, { units: [{ deviceSerial: set[0]!.device, simSerial: set[0]!.sim }] });
    expect(res.status).toBe(200);
    const s = await snapshot(requestId, [set[0]!.deviceId, set[0]!.simId]);
    expect(s.closure).toBe("CLOSED_SUCCESS");
    expect(s.audit).toContain("UNIT_COUNT_MISMATCH");
    const warning = (await db.select().from(courierAuditLogs).where(and(eq(courierAuditLogs.recordId, requestId), eq(courierAuditLogs.action, "UNIT_COUNT_MISMATCH"))))[0]!;
    expect([warning.oldValue, warning.newValue]).toEqual(["2", "1"]);
  });
});
