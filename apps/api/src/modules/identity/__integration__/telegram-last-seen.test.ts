/**
 * "Last used through Telegram" is stamped by the real requireAuthOrInternal on every successful bot request
 * (throttled), never for a refused one, and the user APIs expose it with the other Telegram link facts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@core/config/db";
import { users } from "@shared/schema";
import { requireAuthOrInternal } from "@core/middlewares/auth.middleware";
import { errorHandler } from "@core/errors/errorHandler";
import { toMinimalUserView } from "../presentation/controllers/users.controller";

const KEY = "tg-lastseen-test-key-not-a-secret";
const previousKey = process.env.INTERNAL_SERVICE_KEY;
const tag = randomUUID().slice(0, 8);
const created: string[] = [];
let app: express.Express;
const tgId = () => String(810000000 + Math.floor(Math.random() * 99999999));

async function seed(label: string, over: Partial<typeof users.$inferInsert> = {}) {
  const id = randomUUID();
  await db.insert(users).values({ id, username: `tgseen.${label}.${tag}`, email: `tgseen.${label}.${tag}@test.invalid`, password: "x", fullName: label, role: "technician", ...over });
  created.push(id);
  return id;
}
const call = (tg: string) => request(app).get("/whoami").set("x-internal-service-key", KEY).set("x-telegram-user-id", tg);
const seen = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]!.telegramLastSeenAt;
const settle = () => new Promise((r) => setTimeout(r, 400)); // the stamp is fire-and-forget

beforeAll(() => {
  if (!process.env.DATABASE_URL?.includes("test")) throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
  process.env.INTERNAL_SERVICE_KEY = KEY;
  app = express();
  app.get("/whoami", requireAuthOrInternal, (req, res) => res.json({ id: req.user!.id }));
  app.use(errorHandler);
});
afterAll(async () => {
  if (previousKey === undefined) delete process.env.INTERNAL_SERVICE_KEY;
  else process.env.INTERNAL_SERVICE_KEY = previousKey;
  if (created.length) await db.delete(users).where(inArray(users.id, created));
});

describe("telegram_last_seen_at", () => {
  it("a successful bot request stamps it; a second request within a minute does not move it", async () => {
    const tg = tgId();
    const id = await seed("ok", { telegramUserId: tg });
    expect(await seen(id)).toBeNull();
    expect((await call(tg)).status).toBe(200);
    await settle();
    const first = await seen(id);
    expect(first).toBeInstanceOf(Date);
    expect(Date.now() - first!.getTime()).toBeLessThan(60_000);
    expect((await call(tg)).status).toBe(200);
    await settle();
    expect((await seen(id))!.getTime()).toBe(first!.getTime()); // throttled
  }, 30000);

  it("after a minute the next request stamps again", async () => {
    const tg = tgId();
    const id = await seed("later", { telegramUserId: tg });
    await db.update(users).set({ telegramLastSeenAt: sql`now() - interval '2 minutes'` }).where(eq(users.id, id));
    const before = (await seen(id))!;
    await call(tg);
    await settle();
    expect((await seen(id))!.getTime()).toBeGreaterThan(before.getTime());
  }, 30000);

  it("a refused request (inactive user, unknown Telegram id) stamps nothing", async () => {
    const tg = tgId();
    const id = await seed("inactive", { telegramUserId: tg, isActive: false });
    expect((await call(tg)).status).toBe(401);
    expect((await call(tgId())).status).toBe(401);
    await settle();
    expect(await seen(id)).toBeNull();
  }, 30000);
});

describe("user APIs expose the Telegram link facts", () => {
  const linkedAt = new Date("2026-10-03T02:30:00Z");
  const seenAt = new Date("2026-10-03T03:10:00Z");
  const linkedUser = { id: "u", username: "t", fullName: "T", role: "technician", isActive: true, telegramUserId: "700", telegramUsername: "tech_one", telegramLinkedAt: linkedAt, telegramLastSeenAt: seenAt, password: "$2hash", permissions: null };

  for (const [name, view] of [["users list/detail", toMinimalUserView]] as const) {
    it(`${name}: linked user`, () => {
      const out = view(linkedUser);
      expect(out).toMatchObject({ telegramUserId: "700", telegramUsername: "tech_one", telegramLinked: true, telegramLinkedAt: linkedAt, telegramLastSeenAt: seenAt });
      expect(JSON.stringify(out)).not.toContain("$2hash");
    });
    it(`${name}: unlinked user reports not linked and no dates`, () => {
      expect(view({ ...linkedUser, telegramUserId: null, telegramUsername: null, telegramLinkedAt: null, telegramLastSeenAt: null })).toMatchObject({
        telegramLinked: false, telegramUserId: null, telegramUsername: null, telegramLinkedAt: null, telegramLastSeenAt: null,
      });
    });
  }
});
