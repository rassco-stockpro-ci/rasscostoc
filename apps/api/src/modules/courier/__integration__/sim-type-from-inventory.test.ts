/**
 * SIM TYPE COMES FROM INVENTORY — through the real HTTP routes against
 * PostgreSQL (only authentication is stubbed).
 *
 *   serial-lookup(ICCID) → itemType.carrierName
 *     → close (units[] / legacy lists / PDF) → courier_executions.sim_type
 *     → execution.units[].simType (derived from sim_item_id → items → item_types)
 *
 * The client may restate a type; one that disagrees with the SIM's inventory
 * type is refused (422 SIM_TYPE_MISMATCH) and nothing is written.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@core/config/db";
import {
  users,
  itemTypes,
  items,
  courierRequests,
  courierExecutions,
  courierExecutionUnits,
  courierPdfReports,
  outboxEvents,
} from "@shared/schema";
import { registerCourierRoutes } from "../presentation/routes/courier.routes";
import { errorHandler } from "@core/errors/errorHandler";

const { currentUser } = vi.hoisted(() => ({
  currentUser: { id: "" as string, username: "simtype-actor", role: "admin", regionId: null },
}));
vi.mock("@core/middlewares/auth.middleware", () => ({
  requireAuth: (req: any, _res: any, next: any) => ((req.user = currentUser), next()),
  requireAuthOrInternal: (req: any, _res: any, next: any) => ((req.user = currentUser), next()),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireSupervisor: (_req: any, _res: any, next: any) => next(),
  requireInternalService: (_req: any, _res: any, next: any) => next(),
}));

const COMPLETED = "Installation Completed - NL";

describe("SIM type is derived from inventory (HTTP + PostgreSQL)", () => {
  let app: express.Express;
  let deviceTypeId: string;
  const simTypeIds: Record<"STC" | "Zain" | "NONE", string> = { STC: "", Zain: "", NONE: "" };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    const tag = randomUUID().slice(0, 6);
    deviceTypeId = randomUUID();
    simTypeIds.STC = randomUUID();
    simTypeIds.Zain = randomUUID();
    simTypeIds.NONE = randomUUID();
    await db.insert(itemTypes).values([
      { id: deviceTypeId, nameAr: `جهاز ${tag}`, nameEn: `ST-POS-${tag}`, category: "devices" },
      { id: simTypeIds.STC, nameAr: `شريحة STC ${tag}`, nameEn: `STC SIM ${tag}`, category: "sim" },
      { id: simTypeIds.Zain, nameAr: `شريحة زين ${tag}`, nameEn: `Zain SIM ${tag}`, category: "sim" },
      // a SIM item type whose names resolve to no carrier
      { id: simTypeIds.NONE, nameAr: `شريحة عامة ${tag}`, nameEn: `Generic SIM ${tag}`, category: "sim" },
    ]);
    app = express();
    app.use(express.json());
    registerCourierRoutes(app);
    app.use(errorHandler);
  });

  // ── fixtures ────────────────────────────────────────────────────────────
  const serial = (p: string) => (p + randomUUID().replace(/-/g, "").slice(0, 12)).toUpperCase();
  async function seedTech(label: string) {
    const id = randomUUID();
    const username = `st-${label}-${id.slice(0, 8)}`;
    await db.insert(users).values({ id, username, email: `${username}@test.local`, password: "x", fullName: `ST ${label}`, role: "technician" });
    currentUser.id = id;
    return { id, username };
  }
  async function seedItem(ownerId: string, sn: string, kind: "device" | "STC" | "Zain" | "NONE") {
    const id = randomUUID();
    await db.insert(items).values({
      id, itemTypeId: kind === "device" ? deviceTypeId : simTypeIds[kind], serialNumber: sn, barcode: `${sn}-B`,
      status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: ownerId,
    });
    return id;
  }
  async function seedRequest() {
    const [row] = await db.insert(courierRequests).values({ customerName: "ST", incidentNumber: `ST-${randomUUID().slice(0, 8)}` }).returning();
    return row!.id as number;
  }
  /** One device + one SIM of the given type. */
  async function pair(techId: string, simKind: "STC" | "Zain" | "NONE") {
    const device = serial("STD"), sim = serial("8996STS");
    return { device, sim, deviceId: await seedItem(techId, device, "device"), simId: await seedItem(techId, sim, simKind) };
  }
  const lookup = (sn: string) => request(app).post("/api/courier/serial-lookup").send({ sn });
  const close = (requestId: number, body: Record<string, unknown>) =>
    request(app).post(`/api/courier/executions/${requestId}`).send({ installationStatus: COMPLETED, ...body });
  const storedSimType = async (requestId: number) =>
    (await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId)))[0]?.simType ?? null;
  async function expectNothingWritten(requestId: number, itemIds: string[]) {
    expect(await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId))).toHaveLength(0);
    expect(await db.select().from(courierExecutionUnits).where(eq(courierExecutionUnits.requestId, requestId))).toHaveLength(0);
    const rows = await db.select().from(items).where(inArray(items.id, itemIds));
    expect(rows.every((r) => r.status === "RECEIVED_BY_TECHNICIAN" && r.currentOwnerId)).toBe(true);
  }
  const detail = async (requestId: number) => (await request(app).get(`/api/courier/requests/${requestId}`)).body;

  // ── 1 SIM: lookup → close → PostgreSQL ──────────────────────────────────
  it("1 SIM: lookup returns the type → units[].simType → close → sim_type in PostgreSQL and in the unit read model", async () => {
    const tech = await seedTech("one");
    const p = await pair(tech.id, "STC");
    const requestId = await seedRequest();

    const lk = await lookup(p.sim);
    expect(lk.status).toBe(200);
    expect(lk.body).toMatchObject({ found: true, inActiveCustody: true, itemType: { category: "sim", carrierName: "STC" } });
    expect(lk.body.item).toBeTruthy(); // an exact match: the only kind of result the form derives a type from

    const res = await close(requestId, {
      units: [{ deviceSerial: p.device, simSerial: lk.body.normalized, simType: lk.body.itemType.carrierName }],
    });
    expect(res.status).toBe(200);
    expect(await storedSimType(requestId)).toBe("STC");
    const d = await detail(requestId);
    expect(d.execution.units).toHaveLength(1);
    expect(d.execution.units[0]).toMatchObject({ simSerial: p.sim, simType: "STC" });
    const [unitRow] = await db.select().from(courierExecutionUnits).where(eq(courierExecutionUnits.requestId, requestId));
    expect(unitRow!.simItemId).toBe(p.simId); // the type is derived from THIS inventory item, not stored on the unit
    // other test files share this database: pick the event by this test's own SIM serial, not by request id alone
    const event = (await db.select().from(outboxEvents).where(eq(outboxEvents.eventName, "ExecutionCompletedEvent"))).find(
      (e) => (e.payload as any).requestId === requestId && (e.payload as any).execution?.units?.[0]?.simSerial === p.sim
    );
    expect(event).toBeTruthy();
    expect((event!.payload as any).execution.units[0].simType).toBe("STC");
  }, 30000);

  // ── 2 SIMs: each unit keeps its own type ────────────────────────────────
  it("2 SIMs of different types: SIM A → STC, SIM B → Zain, never mixed", async () => {
    const tech = await seedTech("two");
    const a = await pair(tech.id, "STC");
    const b = await pair(tech.id, "Zain");
    const requestId = await seedRequest();

    expect((await lookup(a.sim)).body.itemType.carrierName).toBe("STC");
    expect((await lookup(b.sim)).body.itemType.carrierName).toBe("Zain");

    const res = await close(requestId, {
      units: [
        { deviceSerial: a.device, simSerial: a.sim, simType: "STC" },
        { deviceSerial: b.device, simSerial: b.sim, simType: "Zain" },
      ],
    });
    expect(res.status).toBe(200);
    const units = (await detail(requestId)).execution.units as any[];
    expect(units.map((u) => [u.simSerial, u.simType])).toEqual([[a.sim, "STC"], [b.sim, "Zain"]]);
    expect(await storedSimType(requestId)).toBe("STC"); // the execution row records unit 1's SIM type
  }, 30000);

  it("2 SIMs closed with the legacy lists: still one type per unit, from inventory", async () => {
    const tech = await seedTech("two-legacy");
    const a = await pair(tech.id, "Zain");
    const b = await pair(tech.id, "STC");
    const requestId = await seedRequest();
    const res = await close(requestId, {
      sn: a.device, simSerial: a.sim, deviceSerials: [a.device, b.device], simSerials: [a.sim, b.sim], simType: "STC",
    });
    expect(res.status).toBe(200); // the legacy scalar names a type that belongs to one of the SIMs
    const units = (await detail(requestId)).execution.units as any[];
    expect(units.map((u) => [u.simSerial, u.simType])).toEqual([[a.sim, "Zain"], [b.sim, "STC"]]);
    expect(await storedSimType(requestId)).toBe("Zain"); // unit 1's type, from inventory — not the scalar the client sent
  }, 30000);

  // ── ICCID not in inventory / held by another technician ─────────────────
  it("an ICCID that is not in inventory: the lookup gives no item and no type, so nothing is shown or sent", async () => {
    await seedTech("ghost");
    const lk = await lookup(serial("8996GHOST"));
    expect(lk.status).toBe(200);
    expect(lk.body.found).toBe(false);
    expect(lk.body.item ?? null).toBeNull();
    expect(lk.body.itemType?.carrierName ?? null).toBeNull();
  });

  it("an ICCID in another technician's custody: the close is refused (422) even with the SIM's true type, nothing written", async () => {
    const owner = await seedTech("owner");
    const sim = serial("8996OTHER");
    const simId = await seedItem(owner.id, sim, "STC");
    const tech = await seedTech("closer"); // the closing technician (currentUser)
    const device = serial("STD");
    const deviceId = await seedItem(tech.id, device, "device");
    const requestId = await seedRequest();

    const lk = await lookup(sim);
    expect(lk.body).toMatchObject({ found: true, itemType: { carrierName: "STC" } });

    const res = await close(requestId, { units: [{ deviceSerial: device, simSerial: sim, simType: "STC" }] });
    expect(res.status).toBe(422);
    await expectNothingWritten(requestId, [deviceId, simId]);
    const [simRow] = await db.select().from(items).where(eq(items.id, simId));
    expect(simRow!.currentOwnerId).toBe(owner.id); // still the other technician's
  });

  // ── forgery: ICCID A + type B ───────────────────────────────────────────
  it("ICCID of an STC SIM + type Zain in units[] → 422 SIM_TYPE_MISMATCH, nothing written", async () => {
    const tech = await seedTech("forge1");
    const p = await pair(tech.id, "STC");
    const requestId = await seedRequest();
    const res = await close(requestId, { units: [{ deviceSerial: p.device, simSerial: p.sim, simType: "Zain" }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("SIM_TYPE_MISMATCH");
    await expectNothingWritten(requestId, [p.deviceId, p.simId]);
  });

  it("the same forgery through the legacy simType field → 422 SIM_TYPE_MISMATCH", async () => {
    const tech = await seedTech("forge2");
    const p = await pair(tech.id, "STC");
    const requestId = await seedRequest();
    const res = await close(requestId, { sn: p.device, simSerial: p.sim, simType: "Zain" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("SIM_TYPE_MISMATCH");
    await expectNothingWritten(requestId, [p.deviceId, p.simId]);
  });

  it("forging only the SECOND unit's type is refused too (the first being right does not excuse it)", async () => {
    const tech = await seedTech("forge3");
    const a = await pair(tech.id, "STC");
    const b = await pair(tech.id, "Zain");
    const requestId = await seedRequest();
    const res = await close(requestId, {
      units: [
        { deviceSerial: a.device, simSerial: a.sim, simType: "STC" },
        { deviceSerial: b.device, simSerial: b.sim, simType: "STC" }, // B is Zain
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("SIM_TYPE_MISMATCH");
    await expectNothingWritten(requestId, [a.deviceId, a.simId, b.deviceId, b.simId]);
  });

  it("a type claimed for a unit that has no SIM → 422 SIM_TYPE_MISMATCH", async () => {
    const tech = await seedTech("forge4");
    const device = serial("STD");
    const deviceId = await seedItem(tech.id, device, "device");
    const requestId = await seedRequest();
    const res = await close(requestId, { units: [{ deviceSerial: device, simWaived: true, simType: "STC" }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("SIM_TYPE_MISMATCH");
    await expectNothingWritten(requestId, [deviceId]);
  });

  // ── what is stored never depends on the client ──────────────────────────
  it("no type sent → the inventory type is stored; the same type in another case is accepted and normalized", async () => {
    const tech = await seedTech("derive");
    const a = await pair(tech.id, "STC");
    const r1 = await seedRequest();
    expect((await close(r1, { units: [{ deviceSerial: a.device, simSerial: a.sim }] })).status).toBe(200);
    expect(await storedSimType(r1)).toBe("STC");

    const b = await pair(tech.id, "Zain");
    const r2 = await seedRequest();
    expect((await close(r2, { units: [{ deviceSerial: b.device, simSerial: b.sim, simType: "zain" }] })).status).toBe(200);
    expect(await storedSimType(r2)).toBe("Zain");
  }, 30000);

  // ── unknown type: never invented ────────────────────────────────────────
  it("a SIM whose item type names no carrier: lookup says so; the close succeeds; no type is invented or taken from the client", async () => {
    const tech = await seedTech("unknown");
    const p = await pair(tech.id, "NONE");
    const requestId = await seedRequest();

    const lk = await lookup(p.sim);
    expect(lk.body).toMatchObject({ found: true, itemType: { category: "sim", carrierName: null } });

    const res = await close(requestId, { units: [{ deviceSerial: p.device, simSerial: p.sim, simType: "STC" }] });
    expect(res.status).toBe(200); // the claim cannot be checked, so it is ignored — and never stored
    expect(await storedSimType(requestId)).toBeNull();
    expect((await detail(requestId)).execution.units[0].simType).toBeNull();
  });

  // ── other channels derive it too ────────────────────────────────────────
  it("PDF approval (the bot's cards carry no SIM type): the execution still records the inventory type", async () => {
    const tech = await seedTech("pdf");
    const p = await pair(tech.id, "STC");
    const requestId = await seedRequest();
    const [pdf] = await db
      .insert(courierPdfReports)
      .values({ requestId, fileName: "r.pdf", filePath: `/tmp/${randomUUID()}.pdf`, uploadedBy: tech.id, status: "pending" })
      .returning();
    const res = await request(app).post(`/api/courier/pdf/${pdf!.id}/complete`).send({
      request_id: requestId,
      devices: [{ sn: p.device, sim_serial: p.sim, tid: "TIDX", technician_code: tech.username }],
      deliveryDate: "2026-10-02",
      time: "10:00",
      paperRoll: "Yes",
    });
    expect(res.status).toBe(200);
    expect(await storedSimType(requestId)).toBe("STC");
    expect((await detail(requestId)).execution.units[0]).toMatchObject({ simSerial: p.sim, simType: "STC" });
  }, 30000);

  it("mobile SUCCESS attempt: type derived; a mismatching restated type is refused", async () => {
    const tech = await seedTech("mobile");
    const p = await pair(tech.id, "Zain");
    const requestId = await seedRequest();
    await db.insert(courierExecutions).values({ requestId, installationStatus: "ACCEPTED", technicianCode: tech.username, enteredBy: tech.id, custodyClosureStatus: "PENDING_DEDUCTION" });

    const bad = await request(app)
      .post(`/api/courier/requests/${requestId}/execution-attempts`)
      .send({ status: "SUCCESS", snInstalled: p.device, simInstalled: p.sim, simType: "STC" });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("SIM_TYPE_MISMATCH");
    expect(await storedSimType(requestId)).toBeNull();

    const ok = await request(app)
      .post(`/api/courier/requests/${requestId}/execution-attempts`)
      .send({ status: "SUCCESS", snInstalled: p.device, simInstalled: p.sim });
    expect(ok.status).toBe(201);
    expect(await storedSimType(requestId)).toBe("Zain");
  }, 30000);
});
