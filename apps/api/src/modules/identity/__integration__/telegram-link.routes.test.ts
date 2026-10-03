/**
 * Telegram self-link, end to end: the real route, the real internal-key middleware, the real use case,
 * PostgreSQL. Nothing is mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@core/config/db";
import { systemLogs, users } from "@shared/schema";
import { hashPassword } from "@server/utils/password";
import { errorHandler } from "@core/errors/errorHandler";
import { registerTelegramLinkRoutes } from "../presentation/routes/telegram-link.routes";

const KEY = "tglink-test-internal-key-not-a-secret";
const PASSWORD = "Correct-Horse-9!";
const tag = randomUUID().slice(0, 8);
const previousKey = process.env.INTERNAL_SERVICE_KEY;
let app: express.Express;
let hash = "";
const created: string[] = [];

const tgId = () => String(800000000 + Math.floor(Math.random() * 99999999));
async function seed(label: string, over: Partial<typeof users.$inferInsert> = {}) {
  const id = randomUUID();
  const username = `TgLink.${label}.${tag}`;
  await db.insert(users).values({ id, username, email: `${username.toLowerCase()}@test.invalid`, password: hash, fullName: `Link ${label}`, role: "technician", ...over });
  created.push(id);
  return { id, username };
}
const post = (body: Record<string, unknown>, key: string | null = KEY) => {
  const r = request(app).post("/api/telegram/link");
  if (key) r.set("x-internal-service-key", key);
  return r.send(body);
};
const row = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]!;
const logs = async (ids: string[]) => db.select().from(systemLogs).where(inArray(systemLogs.entityId, ids));
const strip = (b: any) => {
  const { traceId: _t, ...rest } = b;
  return rest;
};

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("test")) throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
  process.env.INTERNAL_SERVICE_KEY = KEY;
  hash = await hashPassword(PASSWORD);
  app = express();
  app.use(express.json());
  registerTelegramLinkRoutes(app);
  app.use(errorHandler);
});

afterAll(async () => {
  if (previousKey === undefined) delete process.env.INTERNAL_SERVICE_KEY;
  else process.env.INTERNAL_SERVICE_KEY = previousKey;
  if (created.length) {
    await db.delete(systemLogs).where(inArray(systemLogs.entityId, created));
    await db.delete(users).where(inArray(users.id, created));
  }
});

describe("POST /api/telegram/link (real HTTP + PostgreSQL)", () => {
  it("links an active technician: stores id, @username and link time, audits it, and answers with safe fields only", async () => {
    const u = await seed("ok");
    const tg = tgId();
    const res = await post({ telegramUserId: tg, telegramUsername: "tech_ok", username: u.username.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, linked: true, alreadyLinked: false, technician: { id: u.id, username: u.username, name: "Link ok" } });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("$2"); // no bcrypt hash anywhere
    expect(res.headers["cache-control"]).toBe("no-store");

    const saved = await row(u.id);
    expect(saved.telegramUserId).toBe(tg);
    expect(saved.telegramUsername).toBe("tech_ok");
    expect(saved.telegramLinkedAt).toBeInstanceOf(Date);
    expect(Date.now() - saved.telegramLinkedAt!.getTime()).toBeLessThan(60_000);
    const audit = (await logs([u.id])).filter((l) => l.action === "telegram-link");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: "user", severity: "info", success: true });
    expect(audit[0]!.description).toContain(tg);
  }, 30000);

  it("the same account with the same Telegram id again is idempotent (no second audit row)", async () => {
    const u = await seed("again");
    const tg = tgId();
    const body = { telegramUserId: tg, username: u.username, password: PASSWORD };
    expect((await post(body)).status).toBe(200);
    const second = await post(body);
    expect(second.status).toBe(200);
    expect(second.body.alreadyLinked).toBe(true);
    expect((await logs([u.id])).filter((l) => l.action === "telegram-link")).toHaveLength(1);
  }, 30000);

  it("an account already linked to another Telegram id is refused and nothing changes", async () => {
    const tg = tgId();
    const u = await seed("linked", { telegramUserId: tg });
    const res = await post({ telegramUserId: tgId(), username: u.username, password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TELEGRAM_ACCOUNT_ALREADY_LINKED");
    const saved = await row(u.id);
    expect([saved.telegramUserId, saved.telegramLinkedAt]).toEqual([tg, null]);
  }, 30000);

  it("a Telegram id already used by another user is refused (also when stored with a leading @)", async () => {
    const tg = tgId();
    const owner = await seed("owner", { telegramUserId: `@${tg}` });
    const intruder = await seed("intruder");
    const res = await post({ telegramUserId: tg, username: intruder.username, password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TELEGRAM_ID_ALREADY_USED");
    expect((await row(intruder.id)).telegramUserId).toBeNull();
    expect((await row(owner.id)).telegramUserId).toBe(`@${tg}`);
  }, 30000);

  it("unknown user and wrong password are indistinguishable", async () => {
    const u = await seed("enum");
    const wrong = await post({ telegramUserId: tgId(), username: u.username, password: "not-it" });
    const unknown = await post({ telegramUserId: tgId(), username: `ghost.${tag}`, password: "not-it" });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(strip(wrong.body)).toEqual(strip(unknown.body));
    expect((await row(u.id)).telegramUserId).toBeNull();
  }, 30000);

  it("an inactive account and a non-technician are refused only after a valid password; nothing is linked", async () => {
    const inactive = await seed("inactive", { isActive: false });
    const admin = await seed("admin", { role: "admin" });
    const tg = tgId();
    expect((await post({ telegramUserId: tg, username: inactive.username, password: "bad" })).status).toBe(401);
    expect((await post({ telegramUserId: tg, username: admin.username, password: "bad" })).status).toBe(401);
    const a = await post({ telegramUserId: tgId(), username: inactive.username, password: PASSWORD });
    expect([a.status, a.body.code]).toEqual([403, "ACCOUNT_INACTIVE"]);
    const b = await post({ telegramUserId: tgId(), username: admin.username, password: PASSWORD });
    expect([b.status, b.body.code]).toEqual([403, "ROLE_NOT_ALLOWED"]);
    expect((await row(inactive.id)).telegramUserId).toBeNull();
    expect((await row(admin.id)).telegramUserId).toBeNull();
  }, 30000);

  it("attempts are capped per Telegram id: after 5 the correct password is refused with 429 and nothing links", async () => {
    const u = await seed("limit");
    const tg = tgId();
    for (let i = 0; i < 5; i++) expect((await post({ telegramUserId: tg, username: u.username, password: "bad" })).status).toBe(401);
    const res = await post({ telegramUserId: tg, username: u.username, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TELEGRAM_LINK_RATE_LIMITED");
    expect((await row(u.id)).telegramUserId).toBeNull();
    // a different Telegram id is not locked out by someone else's failures
    expect((await post({ telegramUserId: tgId(), username: u.username, password: PASSWORD })).status).toBe(200);
  }, 30000);

  it("only the internal service key is accepted", async () => {
    const u = await seed("key");
    const body = { telegramUserId: tgId(), username: u.username, password: PASSWORD };
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, "wrong-key")).status).toBe(401);
    expect((await row(u.id)).telegramUserId).toBeNull();
  }, 30000);

  it("rejects malformed input (non-numeric id, unknown fields, missing password)", async () => {
    const u = await seed("input");
    const ok = { username: u.username, password: PASSWORD };
    expect((await post({ ...ok, telegramUserId: "abc" })).status).toBe(400);
    expect((await post({ ...ok, telegramUserId: tgId(), role: "admin" })).status).toBe(400);
    expect((await post({ telegramUserId: tgId(), username: u.username })).status).toBe(400);
    expect((await post({ ...ok, telegramUserId: tgId(), password: "x".repeat(201) })).status).toBe(400);
  }, 30000);

  it("two technicians racing for the same Telegram id: exactly one wins", async () => {
    const a = await seed("raceA");
    const b = await seed("raceB");
    const tg = tgId();
    const [ra, rb] = await Promise.all([
      post({ telegramUserId: tg, username: a.username, password: PASSWORD }),
      post({ telegramUserId: tg, username: b.username, password: PASSWORD }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const holders = await db.select({ id: users.id }).from(users).where(eq(users.telegramUserId, tg));
    expect(holders).toHaveLength(1);
  }, 30000);

  it("the password and hash never reach system_logs", async () => {
    const u = await seed("audit");
    await post({ telegramUserId: tgId(), username: u.username, password: "typed-wrong-pw-123" });
    await post({ telegramUserId: tgId(), username: u.username, password: PASSWORD });
    const rows = await logs([u.id, "unknown"]);
    const all = JSON.stringify(rows);
    for (const secret of [PASSWORD, "typed-wrong-pw-123", hash]) expect(all).not.toContain(secret);
    expect(rows.some((r) => r.action === "telegram-link-failed")).toBe(true);
  }, 30000);
});
