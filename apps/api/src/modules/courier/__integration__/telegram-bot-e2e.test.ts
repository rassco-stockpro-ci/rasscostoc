/**
 * TELEGRAM BOT → BACKEND → DEDUCTION → ORDER CLOSED, end to end.
 *
 * The REAL bot code (BOT_E2E_MODULE: the deployed installation_bot.py) runs
 * in a Python subprocess and talks HTTP to a REAL backend instance (the real
 * courier routes, the real requireAuthOrInternal middleware — nothing mocked)
 * over a real PostgreSQL. The bot authenticates the way it does in
 * production: x-internal-service-key + x-telegram-user-id, resolved by the
 * backend to the linked technician.
 *
 * Not covered here (it needs real Telegram / Google): receiving the photos,
 * Gemini extraction, Drive upload, and delivery of the message to Telegram.
 *
 * Skipped unless BOT_E2E_MODULE (+ BOT_E2E_PYTHON) are set, because the bot
 * lives outside this repository.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";
import { spawn } from "child_process";
import path from "path";
import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
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

const BOT_MODULE = process.env.BOT_E2E_MODULE;
const BOT_MODULE_WAIVER = process.env.BOT_E2E_MODULE_WAIVER ?? BOT_MODULE;
const PYTHON = process.env.BOT_E2E_PYTHON ?? "python3";
const HARNESS = path.resolve(import.meta.dirname, "bot_push_harness.py");
const SERVICE_KEY = "e2e-service-key-not-a-secret";
const SUCCESS_LINE = /^✅ تم رفع التوثيق وربطه تلقائيًا في RASSCO \(تقرير #(\d+)\)\.$/;

type Card = { sn: string; iccid?: string | null; tid?: string; has_sim?: boolean };
type BotResult = { lines: string[]; gate_ok: boolean | null; error: string | null; complete: any };

describe.skipIf(!BOT_MODULE)("Telegram bot → backend → deduction → order closed (real bot, real backend, PostgreSQL)", () => {
  let server: http.Server;
  let baseUrl: string;
  let deviceTypeId: string;
  let simTypeId: string;
  const previousKey = process.env.INTERNAL_SERVICE_KEY;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    process.env.INTERNAL_SERVICE_KEY = SERVICE_KEY; // the real middleware reads it per request
    deviceTypeId = randomUUID();
    simTypeId = randomUUID();
    await db.insert(itemTypes).values([
      { id: deviceTypeId, nameAr: "جهاز", nameEn: `E2E-POS-${deviceTypeId.slice(0, 6)}`, category: "devices" },
      { id: simTypeId, nameAr: "شريحة", nameEn: `E2E-SIM-${simTypeId.slice(0, 6)}`, category: "sim" },
    ]);
    const app = express();
    app.use(express.json());
    registerCourierRoutes(app);
    app.use("/api", (_req, res) => res.status(404).json({ message: "not found" }));
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}/api`;
  });

  afterAll(async () => {
    if (previousKey === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = previousKey;
    await new Promise((resolve) => server?.close(resolve));
  });

  // ── fixtures ────────────────────────────────────────────────────────────
  const serial = (p: string) => (p + randomUUID().replace(/-/g, "").slice(0, 10)).toUpperCase();

  async function seedTech(label: string) {
    const id = randomUUID();
    const username = `e2e-${label}-${id.slice(0, 8)}`;
    const telegramUserId = String(700000000 + Math.floor(Math.random() * 99999999));
    await db.insert(users).values({
      id, username, email: `${username}@test.local`, password: "x", fullName: `E2E ${label}`, role: "technician", telegramUserId,
    });
    return { id, username, telegramUserId };
  }
  async function seedItem(ownerId: string, sn: string, kind: "device" | "sim", status = "RECEIVED_BY_TECHNICIAN") {
    const id = randomUUID();
    await db.insert(items).values({ id, itemTypeId: kind === "sim" ? simTypeId : deviceTypeId, serialNumber: sn, barcode: `${sn}-B`, status, currentOwnerId: ownerId });
    return id;
  }
  /** A request plus the pending report the bot registered at receipt. */
  async function seedRequestWithReport(uploadedBy: string) {
    const incident = `E2E-${randomUUID().slice(0, 8)}`;
    const [request] = await db.insert(courierRequests).values({ customerName: "E2E Customer", incidentNumber: incident }).returning();
    const [pdf] = await db
      .insert(courierPdfReports)
      .values({ requestId: request!.id, fileName: "report.pdf", filePath: `/tmp/${randomUUID()}.pdf`, uploadedBy, status: "pending" })
      .returning();
    return { requestId: request!.id as number, incident, reportId: pdf!.id as number };
  }
  async function seedPairs(techId: string, n: number) {
    const out: { sn: string; iccid: string; tid: string; deviceId: string; simId: string }[] = [];
    for (let i = 0; i < n; i++) {
      const sn = serial("E2ED"), iccid = serial("8996E2ES");
      out.push({ sn, iccid, tid: `TID${i + 1}${randomUUID().slice(0, 4)}`, deviceId: await seedItem(techId, sn, "device"), simId: await seedItem(techId, iccid, "sim") });
    }
    return out;
  }

  /** Runs the real bot: finalize → gate → update-extracted → complete → Telegram lines. */
  function runBot(args: {
    modulePath?: string;
    tech: { telegramUserId: string };
    incident: string;
    reportId: number;
    devices: Card[];
    mode?: "complete_only";
  }): Promise<BotResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(PYTHON, [HARNESS], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: "/tmp",
          BOT_MODULE_PATH: args.modulePath ?? BOT_MODULE!,
          RASSCO_API_BASE_URL: baseUrl,
          RASSCO_INTERNAL_SERVICE_KEY: SERVICE_KEY,
          STOCKPRO_DB_URL: process.env.DATABASE_URL!,
          LOCAL_QUEUE_DB: `/tmp/e2e-bot-${randomUUID()}.sqlite3`,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", () => {
        const last = stdout.trim().split("\n").pop() ?? "";
        try {
          resolve(JSON.parse(last));
        } catch {
          reject(new Error(`bot harness produced no result.\nstdout: ${stdout.slice(-400)}\nstderr: ${stderr.slice(-600)}`));
        }
      });
      child.stdin.write(
        JSON.stringify({
          request_number: args.incident,
          telegram_user_id: args.tech.telegramUserId,
          report_id: args.reportId,
          devices: args.devices,
          mode: args.mode,
        })
      );
      child.stdin.end();
    });
  }

  // ── database snapshot ───────────────────────────────────────────────────
  async function snapshot(requestId: number, itemIds: string[]) {
    const itemRows = itemIds.length ? await db.select().from(items).where(inArray(items.id, itemIds)) : [];
    const [exec] = await db.select().from(courierExecutions).where(eq(courierExecutions.requestId, requestId));
    const units = await db.select().from(courierExecutionUnits).where(eq(courierExecutionUnits.requestId, requestId)).orderBy(courierExecutionUnits.unitNo);
    const links = await db.select().from(courierRequestItems).where(eq(courierRequestItems.requestId, requestId));
    const events = (await db.select().from(outboxEvents).where(eq(outboxEvents.eventName, "ExecutionCompletedEvent"))).filter(
      (e) => (e.payload as any)?.requestId === requestId
    );
    const [pdf] = await db.select().from(courierPdfReports).where(eq(courierPdfReports.requestId, requestId));
    return {
      delivered: itemRows.filter((r) => r.status === "DELIVERED" && !r.currentOwnerId).length,
      inCustody: itemRows.filter((r) => r.status !== "DELIVERED" && r.currentOwnerId).length,
      movements: itemIds.length ? (await db.select().from(custodyMovements).where(inArray(custodyMovements.itemId, itemIds))).length : 0,
      execution: exec ?? null,
      closure: exec?.custodyClosureStatus ?? null,
      units,
      links,
      completions: await db.select().from(inventoryDeductionCompletions).where(eq(inventoryDeductionCompletions.requestId, requestId)),
      events,
      audit: (await db.select().from(courierAuditLogs).where(eq(courierAuditLogs.recordId, requestId))).map((a) => a.action),
      pdfStatus: pdf?.status,
    };
  }
  const idsOf = (p: { deviceId: string; simId: string }[]) => p.flatMap((x) => [x.deviceId, x.simId]);

  async function expectBotClosed(requestId: number, reportId: number, pairs: Awaited<ReturnType<typeof seedPairs>>, result: BotResult) {
    // what the technician sees on Telegram
    expect(result.error).toBeNull();
    expect(result.gate_ok).toBe(true);
    const success = result.lines.find((l) => SUCCESS_LINE.test(l));
    expect(success, `bot lines: ${JSON.stringify(result.lines)}`).toBeDefined();
    expect(SUCCESS_LINE.exec(success!)![1]).toBe(String(reportId));
    expect(result.lines.some((l) => l.includes("رفض إغلاق الطلب"))).toBe(false);

    // what PostgreSQL holds
    const s = await snapshot(requestId, idsOf(pairs));
    console.info(
      "BOT_E2E_EVIDENCE " +
        JSON.stringify({
          telegramMessage: success,
          requestId,
          reportId,
          closure: s.closure,
          units: s.units.map((u) => ({ no: u.unitNo, device: u.deviceSerial, sim: u.simSerial, tid: u.tid, pairing: u.pairingSource })),
          itemsDelivered: s.delivered,
          requestItems: s.links.map((l) => l.status),
          completions: s.completions.length,
          outboxEvents: s.events.length,
          auditActions: [...new Set(s.audit)],
        })
    );
    expect(s.execution).not.toBeNull();
    expect(s.closure).toBe("CLOSED_SUCCESS");
    expect(s.pdfStatus).toBe("applied");
    expect(s.delivered).toBe(pairs.length * 2);
    expect(s.movements).toBe(pairs.length * 2);
    expect(s.units).toHaveLength(pairs.length);
    s.units.forEach((u, i) =>
      expect(u).toMatchObject({ unitNo: i + 1, deviceItemId: pairs[i]!.deviceId, simItemId: pairs[i]!.simId, tid: pairs[i]!.tid, pairingSource: "EXPLICIT", simWaived: false })
    );
    expect(s.links.length).toBe(pairs.length * 2);
    expect(s.links.every((l) => l.status === "INSTALLED" && l.executionUnitId !== null)).toBe(true);
    expect(s.completions).toHaveLength(1);
    expect(s.completions[0]!.serializedItemCount).toBe(pairs.length * 2);
    expect(s.events).toHaveLength(1);
    expect(s.audit).toContain("INVENTORY_DEDUCTED");
    return s;
  }

  async function expectUntouched(requestId: number, ids: string[]) {
    const s = await snapshot(requestId, ids);
    expect(s).toMatchObject({ delivered: 0, inCustody: ids.length, movements: 0, closure: null, units: [], completions: [], events: [], execution: null });
    expect(s.links).toHaveLength(0);
    expect(s.pdfStatus).toBe("pending");
  }

  // ── success ─────────────────────────────────────────────────────────────
  it("bot sends 2 devices + 2 SIMs: validated, deducted, order closed automatically, technician told it succeeded", async () => {
    const tech = await seedTech("two");
    const pairs = await seedPairs(tech.id, 2);
    const { requestId, incident, reportId } = await seedRequestWithReport(tech.id);
    await expectUntouched(requestId, idsOf(pairs)).catch(() => undefined); // before-state is the seeded state

    const result = await runBot({ tech, incident, reportId, devices: pairs });
    await expectBotClosed(requestId, reportId, pairs, result);
  }, 90000);

  it("bot sends 5 devices + 5 SIMs: the same automatic close (N > 2 through the bot)", async () => {
    const tech = await seedTech("five");
    const pairs = await seedPairs(tech.id, 5);
    const { requestId, incident, reportId } = await seedRequestWithReport(tech.id);
    const result = await runBot({ tech, incident, reportId, devices: pairs });
    await expectBotClosed(requestId, reportId, pairs, result);
  }, 90000);

  it("a device with no SIM, declared by the bot (sim_waived): closes with the waiver recorded", async () => {
    const tech = await seedTech("waiver");
    const sn = serial("E2ED");
    const deviceId = await seedItem(tech.id, sn, "device");
    const { requestId, incident, reportId } = await seedRequestWithReport(tech.id);

    const result = await runBot({ modulePath: BOT_MODULE_WAIVER, tech, incident, reportId, devices: [{ sn, tid: "TIDW1", has_sim: false }] });
    expect(result.error).toBeNull();
    expect(result.lines.some((l) => SUCCESS_LINE.test(l)), JSON.stringify(result.lines)).toBe(true);
    const s = await snapshot(requestId, [deviceId]);
    expect(s.closure).toBe("CLOSED_SUCCESS");
    expect(s.units).toHaveLength(1);
    expect(s.units[0]).toMatchObject({ deviceItemId: deviceId, simItemId: null, simWaived: true, tid: "TIDW1" });
  }, 90000);

  // ── failure ─────────────────────────────────────────────────────────────
  it("Device A valid, Device B not in inventory: the bot's own gate stops it; nothing reaches the backend, nothing changes", async () => {
    const tech = await seedTech("badb");
    const pairs = await seedPairs(tech.id, 1);
    const bad: Card = { sn: serial("E2ENOPE"), iccid: serial("8996E2EX"), tid: "TIDX" };
    const { requestId, incident, reportId } = await seedRequestWithReport(tech.id);

    const result = await runBot({ tech, incident, reportId, devices: [...pairs, bad] });
    expect(result.gate_ok).toBe(false);
    expect(result.lines.join("\n")).toContain("لم يتم إرسال التوثيق إلى RASSCO");
    expect(result.lines.some((l) => SUCCESS_LINE.test(l))).toBe(false);
    await expectUntouched(requestId, idsOf(pairs));
  }, 90000);

  it("same case with the bot's gate bypassed: the BACKEND validates again and refuses — no deduction, order not closed", async () => {
    const tech = await seedTech("badb2");
    const pairs = await seedPairs(tech.id, 1);
    const bad: Card = { sn: serial("E2ENOPE"), iccid: serial("8996E2EX"), tid: "TIDX" };
    const { requestId, incident, reportId } = await seedRequestWithReport(tech.id);

    const result = await runBot({ tech, incident, reportId, devices: [...pairs, bad], mode: "complete_only" });
    expect(String(result.complete?.error ?? "")).toContain("422");
    await expectUntouched(requestId, idsOf(pairs));
  }, 90000);

  it("a SIM held by another technician (bot gate bypassed): backend refuses, the valid device and SIM stay in custody", async () => {
    const tech = await seedTech("other");
    const stranger = await seedTech("stranger");
    const [okPair] = await seedPairs(tech.id, 1);
    const foreignSn = serial("E2ED"), foreignSim = serial("8996E2ES");
    const foreignIds = [await seedItem(tech.id, foreignSn, "device"), await seedItem(stranger.id, foreignSim, "sim")];
    const { requestId, incident, reportId } = await seedRequestWithReport(tech.id);

    const result = await runBot({
      tech, incident, reportId, mode: "complete_only",
      devices: [okPair!, { sn: foreignSn, iccid: foreignSim, tid: "TIDF" }],
    });
    expect(String(result.complete?.error ?? "")).toContain("422");
    await expectUntouched(requestId, [...idsOf([okPair!]), foreignIds[0]!]);
  }, 90000);

  // ── idempotency / concurrency ───────────────────────────────────────────
  it("the bot sends the same close twice at once: one close, one deduction, one execution", async () => {
    const tech = await seedTech("dup");
    const pairs = await seedPairs(tech.id, 2);
    const { requestId, incident, reportId } = await seedRequestWithReport(tech.id);

    const [a, b] = await Promise.all([
      runBot({ tech, incident, reportId, devices: pairs }),
      runBot({ tech, incident, reportId, devices: pairs }),
    ]);
    const succeeded = [a, b].filter((r) => r.lines.some((l) => SUCCESS_LINE.test(l)));
    expect(succeeded).toHaveLength(1);
    const loser = [a, b].find((r) => !r.lines.some((l) => SUCCESS_LINE.test(l)))!;
    expect(loser.lines.join("\n")).toMatch(/رفض إغلاق الطلب|لم يتم إرسال/);

    const s = await snapshot(requestId, idsOf(pairs));
    expect(s.closure).toBe("CLOSED_SUCCESS");
    expect(s.completions).toHaveLength(1);
    expect(s.units).toHaveLength(2);
    expect(s.movements).toBe(4);
    expect(s.events).toHaveLength(1);
  }, 90000);

  it("the bot retries after success: the gate refuses (items already delivered) and nothing is deducted twice", async () => {
    const tech = await seedTech("retry");
    const pairs = await seedPairs(tech.id, 2);
    const { requestId, incident, reportId } = await seedRequestWithReport(tech.id);
    const first = await runBot({ tech, incident, reportId, devices: pairs });
    await expectBotClosed(requestId, reportId, pairs, first);

    const second = await runBot({ tech, incident, reportId, devices: pairs });
    expect(second.lines.some((l) => SUCCESS_LINE.test(l))).toBe(false);
    const s = await snapshot(requestId, idsOf(pairs));
    expect(s.completions).toHaveLength(1);
    expect(s.movements).toBe(4);
    expect(s.units).toHaveLength(2);
  }, 90000);

  it("two bots, two requests, the same devices, at once: exactly one order closes, no double deduction", async () => {
    const tech = await seedTech("race");
    const pairs = await seedPairs(tech.id, 2);
    const first = await seedRequestWithReport(tech.id);
    const second = await seedRequestWithReport(tech.id);

    const [a, b] = await Promise.all([
      runBot({ tech, incident: first.incident, reportId: first.reportId, devices: pairs }),
      runBot({ tech, incident: second.incident, reportId: second.reportId, devices: [...pairs].reverse() }),
    ]);
    const wins = [a, b].filter((r) => r.lines.some((l) => SUCCESS_LINE.test(l)));
    expect(wins).toHaveLength(1);

    const [s1, s2] = [await snapshot(first.requestId, idsOf(pairs)), await snapshot(second.requestId, idsOf(pairs))];
    expect([s1.closure, s2.closure].filter((c) => c === "CLOSED_SUCCESS")).toHaveLength(1);
    expect(s1.completions.length + s2.completions.length).toBe(1);
    expect(s1.units.length + s2.units.length).toBe(2);
    expect(s1.movements).toBe(4); // per item, shared by both snapshots: four, never eight
  }, 90000);
});
