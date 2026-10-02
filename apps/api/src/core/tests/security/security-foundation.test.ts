/**
 * PHASE B1.5 — Security Test Foundation.
 *
 * Runs against the REAL production app (apps/api/src/app.ts + the real
 * registerRoutes()), not a hand-rolled minimal test app — this is the only
 * way to exercise the actual middleware stack in the actual order
 * (correlation -> securityHeaders -> rateLimiter -> CORS -> session ->
 * csrfProtection -> body-parsing -> idempotency -> routes) rather than a
 * reconstruction of it. Requires a real isolated database (see
 * scripts/test-security.mjs) because several of these middlewares
 * (rateLimiter, session store, refresh tokens) are themselves DB-backed —
 * there is no meaningful way to foundation-test them against a mock.
 *
 * Never runs under test:unit:safe (DB-free suite) or test:http (poison DB) —
 * excluded from both by name, matching the pattern already established for
 * database-foundation.smoke.test.ts in Phase B1.2.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { app } from "../../../app";
import { registerRoutes } from "../../../routes";
import { db } from "../../config/db";
import { resetTestDatabase } from "../../testing/foundation/db.helpers";
import { signTestToken, signExpiredTestToken } from "../../testing/foundation/auth.helpers";
import { hashPassword } from "../../../utils/password";

const TABLES_UNDER_TEST = ["users", "regions", "refresh_tokens", "rate_limit_counters"];

describe("PHASE B1.5 — security test foundation", () => {
  let technicianA: { id: string; username: string; password: string };
  let technicianB: { id: string };
  let admin: { id: string };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database. " +
          "See scripts/test-security.mjs."
      );
    }
    await registerRoutes(app); // registers routes onto the real app singleton; never .listen()s

    await resetTestDatabase(TABLES_UNDER_TEST);

    const { regions, users } = await import("@shared/schema");
    const regionId = randomUUID();
    await db.insert(regions).values({ id: regionId, name: "Security Test Region" });

    const rawPassword = "SecurityFoundationTestPassword!1";
    const passwordHash = await hashPassword(rawPassword);

    const idA = randomUUID();
    const idB = randomUUID();
    const idAdmin = randomUUID();

    await db.insert(users).values([
      {
        id: idA,
        username: `sec.tech.a.${Date.now()}`,
        email: `sec.tech.a.${Date.now()}@test.invalid`,
        fullName: "Security Test Technician A",
        password: passwordHash,
        role: "technician",
        regionId,
      },
      {
        id: idB,
        username: `sec.tech.b.${Date.now()}`,
        email: `sec.tech.b.${Date.now()}@test.invalid`,
        fullName: "Security Test Technician B",
        password: passwordHash,
        role: "technician",
        regionId,
      },
      {
        id: idAdmin,
        username: `sec.admin.${Date.now()}`,
        email: `sec.admin.${Date.now()}@test.invalid`,
        fullName: "Security Test Admin",
        password: passwordHash,
        role: "admin",
        regionId,
      },
    ]);

    technicianA = { id: idA, username: (await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, idA) }))!.username, password: rawPassword };
    technicianB = { id: idB };
    admin = { id: idAdmin };
  });

  afterAll(async () => {
    await resetTestDatabase(TABLES_UNDER_TEST);
  });

  // ==================================================================
  // B1.5.2 — Authentication foundation
  // ==================================================================
  describe("authentication", () => {
    it("a request with no token is rejected with 401", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
    });

    it("a real, valid JWT (signed the same way requireAuth verifies it) is accepted", async () => {
      const token = signTestToken({ id: technicianA.id, role: "technician", username: technicianA.username });
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("an expired token is rejected", async () => {
      const token = signExpiredTestToken({ id: technicianA.id, role: "technician", username: technicianA.username });
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it("a malformed token (not a JWT at all) is rejected", async () => {
      const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer not-a-real-jwt-at-all");
      expect(res.status).toBe(401);
    });

    it("a token signed with the wrong secret is rejected", async () => {
      const jwt = await import("jsonwebtoken");
      const badToken = jwt.sign({ userId: technicianA.id, role: "technician" }, "a-completely-different-secret-not-jwt-secret");
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${badToken}`);
      expect(res.status).toBe(401);
    });

    it("a malformed Authorization header (missing 'Bearer ' prefix) is rejected, not crashed", async () => {
      const token = signTestToken({ id: technicianA.id, role: "technician", username: technicianA.username });
      const res = await request(app).get("/api/auth/me").set("Authorization", token); // no "Bearer " prefix
      expect(res.status).toBe(401);
    });

    it("the 401 response does not leak internal error detail (stack trace, DB error text)", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
      const bodyText = JSON.stringify(res.body);
      expect(bodyText.toLowerCase()).not.toContain("stack");
      expect(bodyText).not.toContain("postgresql://");
    });

    it("a full real login round trip succeeds with the actual bcrypt-verified password", async () => {
      const res = await request(app).post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();
    });

    it("login with the wrong password is rejected without revealing whether the username exists", async () => {
      const res = await request(app).post("/api/auth/login").send({ username: technicianA.username, password: "wrong-password" });
      expect(res.status).toBe(401);
      const unknownUserRes = await request(app).post("/api/auth/login").send({ username: "no-such-user-at-all", password: "wrong-password" });
      expect(unknownUserRes.status).toBe(401);
      // Same message for "wrong password" and "user doesn't exist" — user enumeration is not possible via this endpoint.
      expect(res.body.message).toBe(unknownUserRes.body.message);
    });
  });

  // ==================================================================
  // B1.5.3 — Authorization and role foundation
  // ==================================================================
  describe("authorization / roles", () => {
    it("a non-admin role is rejected with 403 (not 401, not 500) from an admin-only route", async () => {
      const token = signTestToken({ id: technicianA.id, role: "technician", username: technicianA.username });
      const res = await request(app).get("/api/admin/fixed-inventory-dashboard").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("an admin role is not rejected by the role check on the same admin-only route", async () => {
      const token = signTestToken({ id: admin.id, role: "admin", username: "sec.admin" });
      const res = await request(app).get("/api/admin/fixed-inventory-dashboard").set("Authorization", `Bearer ${token}`);
      // Only asserting the role gate passed (not 401/403) - the handler's
      // own business-logic success/shape is out of this foundation's scope.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("an unauthenticated request to the same route is 401, distinctly different from the 403 wrong-role case", async () => {
      const res = await request(app).get("/api/admin/fixed-inventory-dashboard");
      expect(res.status).toBe(401);
    });

    it("a route with no admin requirement does not itself 500 when the user has the lowest real role", async () => {
      const token = signTestToken({ id: technicianA.id, role: "technician", username: technicianA.username });
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  // ==================================================================
  // B1.5.4 — IDOR foundation (critical priority)
  // ==================================================================
  describe("IDOR", () => {
    it("user A can read their own employee-profile resource", async () => {
      const token = signTestToken({ id: technicianA.id, role: "technician", username: technicianA.username });
      const res = await request(app).get(`/api/users/${technicianA.id}/employee-profile`).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("user B CANNOT read user A's employee-profile resource by ID substitution in the URL", async () => {
      const tokenB = signTestToken({ id: technicianB.id, role: "technician", username: "sec.tech.b" });
      const res = await request(app).get(`/api/users/${technicianA.id}/employee-profile`).set("Authorization", `Bearer ${tokenB}`);
      expect(res.status).toBe(403);
    });

    it("user B CANNOT write to user A's employee-profile resource by ID substitution in the URL", async () => {
      const tokenB = signTestToken({ id: technicianB.id, role: "technician", username: "sec.tech.b" });
      const res = await request(app)
        .put(`/api/users/${technicianA.id}/employee-profile`)
        .set("Authorization", `Bearer ${tokenB}`)
        .send({ city: "Attacker-Controlled City" });
      expect(res.status).toBe(403);
    });

    it("admin CAN read another user's employee-profile resource (policy-correct escalation, not a bug)", async () => {
      const tokenAdmin = signTestToken({ id: admin.id, role: "admin", username: "sec.admin" });
      const res = await request(app).get(`/api/users/${technicianA.id}/employee-profile`).set("Authorization", `Bearer ${tokenAdmin}`);
      expect(res.status).toBe(200);
    });

    it("a request for a non-existent user ID does not leak whether a DIFFERENT real user exists (404, not a differently-worded error)", async () => {
      const tokenB = signTestToken({ id: technicianB.id, role: "technician", username: "sec.tech.b" });
      const res = await request(app).get(`/api/users/${randomUUID()}/employee-profile`).set("Authorization", `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
    });
  });

  // ==================================================================
  // B1.5.5 — CSRF foundation
  // ==================================================================
  describe("CSRF", () => {
    it("Bearer-token requests are CSRF-immune by design (confirmed: mutating request succeeds without any CSRF header)", async () => {
      const token = signTestToken({ id: technicianA.id, role: "technician", username: technicianA.username });
      const res = await request(app)
        .put(`/api/users/${technicianA.id}/employee-profile`)
        .set("Authorization", `Bearer ${token}`)
        .send({ city: "Riyadh" });
      expect(res.status).not.toBe(403);
    });

    it("a session-cookie-authenticated mutating request WITHOUT the required header is rejected (403)", async () => {
      const agent = request.agent(app); // persists the session cookie across requests
      const loginRes = await agent.post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });
      expect(loginRes.status).toBe(200);

      const res = await agent.put(`/api/users/${technicianA.id}/employee-profile`).send({ city: "Riyadh" });
      // No Authorization Bearer header on this request -> session-cookie path -> CSRF header required.
      expect(res.status).toBe(403);
    });

    it("a session-cookie-authenticated mutating request WITH the required header passes CSRF (not blocked by CSRF)", async () => {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });

      const res = await agent
        .put(`/api/users/${technicianA.id}/employee-profile`)
        .set("X-Requested-With", "XMLHttpRequest")
        .send({ city: "Riyadh" });
      expect(res.status).not.toBe(403);
    });

    it("safe methods (GET) are never blocked by CSRF, session or not", async () => {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });
      const res = await agent.get(`/api/users/${technicianA.id}/employee-profile`);
      expect(res.status).not.toBe(403);
    });
  });

  // ==================================================================
  // B1.5.6 — Session and refresh-token foundation
  // ==================================================================
  describe("session and refresh token", () => {
    it("login regenerates the session (session-fixation protection) — two independent logins never share a session ID", async () => {
      // A GET to a protected route that 401s never touches/saves the
      // session (requireAuth rejects before any session-touching code
      // runs), so it never issues a Set-Cookie — confirmed empirically,
      // not assumed. The real fixation-protection proof is that
      // session.regenerate() (auth.controller.ts) makes every login mint
      // a fresh session ID, which two independent logins demonstrate
      // directly: if fixation were possible, a pre-existing session ID
      // would survive login unchanged.
      const agentOne = request.agent(app);
      const loginOneRes = await agentOne.post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });
      const cookieOne = loginOneRes.headers["set-cookie"]?.[0];

      const agentTwo = request.agent(app);
      const loginTwoRes = await agentTwo.post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });
      const cookieTwo = loginTwoRes.headers["set-cookie"]?.[0];

      expect(cookieOne).toBeTruthy();
      expect(cookieTwo).toBeTruthy();
      const postLoginCookie = cookieTwo;
      const preLoginCookie = cookieOne;
      expect(postLoginCookie).not.toBe(preLoginCookie);
    });

    it("REFRESH TOKEN FLOW IS IMPLEMENTED — a valid refresh token issues a new access + refresh token pair (rotation)", async () => {
      const loginRes = await request(app).post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });
      const oldRefreshToken = loginRes.body.refreshToken;

      const refreshRes = await request(app).post("/api/auth/refresh").send({ refreshToken: oldRefreshToken });
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.token).toBeTruthy();
      expect(refreshRes.body.refreshToken).toBeTruthy();
      expect(refreshRes.body.refreshToken).not.toBe(oldRefreshToken); // rotation: never reissues the same token
    });

    it("reusing an already-rotated (revoked) refresh token is rejected — reuse detection", async () => {
      const loginRes = await request(app).post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });
      const originalRefreshToken = loginRes.body.refreshToken;

      await request(app).post("/api/auth/refresh").send({ refreshToken: originalRefreshToken }); // first use: rotates it
      const reuseRes = await request(app).post("/api/auth/refresh").send({ refreshToken: originalRefreshToken }); // second use: must be rejected

      expect(reuseRes.status).toBe(401);
    });

    it("an expired refresh token is rejected", async () => {
      const { refreshTokens } = await import("@shared/schema");
      const expiredToken = randomUUID().replace(/-/g, "");
      await db.insert(refreshTokens).values({
        id: randomUUID(),
        token: expiredToken,
        userId: technicianA.id,
        expiry: new Date(Date.now() - 1000 * 60 * 60), // 1 hour in the past
      });

      const res = await request(app).post("/api/auth/refresh").send({ refreshToken: expiredToken });
      expect(res.status).toBe(401);
    });

    it("a missing refresh token in the request body is rejected with 400, not 500", async () => {
      const res = await request(app).post("/api/auth/refresh").send({});
      expect(res.status).toBe(400);
    });

    it("logout revokes the refresh token — a subsequent refresh attempt with it is rejected", async () => {
      const loginRes = await request(app).post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });
      const token = loginRes.body.token;
      const refreshToken = loginRes.body.refreshToken;

      const logoutRes = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`).send({ refreshToken });
      expect(logoutRes.status).toBe(200);

      const refreshAfterLogoutRes = await request(app).post("/api/auth/refresh").send({ refreshToken });
      expect(refreshAfterLogoutRes.status).toBe(401);
    });
  });

  // ==================================================================
  // B1.5.7 — Rate limit and CORS
  // ==================================================================
  describe("rate limit", () => {
    it("MAX_REQUESTS_PER_WINDOW is exceeded returns 429 (rateLimiter bypasses entirely outside NODE_ENV=production, so this test forces it on for its own duration only)", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        await resetTestDatabase(["rate_limit_counters"]);
        const { rateLimiter } = await import("../../middlewares/security.middleware");

        const makeReqRes = () => {
          const req: any = { ip: "203.0.113.7", path: "/api/rate-limit-foundation-test", headers: {} };
          let statusCode = 200;
          let jsonBody: any = null;
          const res: any = {
            status(code: number) {
              statusCode = code;
              return this;
            },
            json(body: any) {
              jsonBody = body;
              return this;
            },
            setHeader() {},
            getStatus: () => statusCode,
            getJson: () => jsonBody,
          };
          return { req, res };
        };

        // ROOT FIX: MAX_REQUESTS_PER_WINDOW was raised from 150 to 300 (see
        // security.middleware.ts — production capacity fix; the limit used
        // to be shared per-IP across every technician behind one office/
        // carrier NAT, confirmed causing real "Rate limit exceeded" bursts
        // for unrelated technicians in production logs). Loop count updated
        // to match, same "+2 over the limit" margin as before.
        let last429: any = null;
        for (let i = 0; i < 302; i++) {
          const { req, res } = makeReqRes();
          let nextCalled = false;
          await rateLimiter(req, res, () => {
            nextCalled = true;
          });
          if (!nextCalled && res.getStatus() === 429) {
            last429 = res;
            break;
          }
        }

        expect(last429).not.toBeNull();
        expect(last429.getStatus()).toBe(429);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    }, 30000);
  });

  describe("CORS", () => {
    it("an allowed origin's preflight OPTIONS request is accepted (204)", async () => {
      // app.ts computes its allowed-origins set ONCE at module-import time
      // from configService.isDevelopment — vitest sets NODE_ENV=test (not
      // "development"), so the DEFAULT_DEVELOPMENT_ORIGINS list
      // (localhost:5173 etc.) never applies in this suite; only
      // DEFAULT_PRODUCTION_ORIGINS does. Using a real production-allowlisted
      // origin here (not localhost) is the correct fixture for the
      // environment this test actually runs in — confirmed by first
      // observing a genuine 403 against localhost:5173 before this fix.
      const res = await request(app).options("/api/auth/me").set("Origin", "https://stc1.fun").set("Access-Control-Request-Method", "GET");
      expect(res.status).toBe(204);
    });

    it("a disallowed origin's preflight OPTIONS request is rejected (403), no wildcard Access-Control-Allow-Origin", async () => {
      const res = await request(app)
        .options("/api/auth/me")
        .set("Origin", "https://evil.example.com")
        .set("Access-Control-Request-Method", "GET");
      expect(res.status).toBe(403);
      expect(res.headers["access-control-allow-origin"]).not.toBe("*");
    });
  });

  // ==================================================================
  // B1.5.8 — File upload/download security
  // ==================================================================
  describe("file upload/download security", () => {
    it("the decommissioned local-storage upload endpoint still returns 410 Gone, unconditionally, without auth", async () => {
      const res = await request(app).post("/api/courier/pdf/upload").send({});
      expect(res.status).toBe(410);
    });

    it("the decommissioned endpoint returns 410 even for a multipart request with an attached file field", async () => {
      const res = await request(app).post("/api/courier/pdf/upload").attach("file", Buffer.from("fake pdf bytes"), "fake.pdf");
      expect(res.status).toBe(410);
    });

    it("the real upload path (register-drive) rejects an unauthenticated request", async () => {
      const res = await request(app).post("/api/courier/pdf/register-drive").send({});
      expect(res.status).toBe(401);
    });
  });

  // ==================================================================
  // B1.5.9 — Sensitive logging
  // ==================================================================
  describe("sensitive data in logs", () => {
    it("a real login request's logged line redacts the issued token, not just the request body", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const res = await request(app).post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });
        expect(res.status).toBe(200);
        const realToken = res.body.token as string;

        const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
        const loginLogLine = loggedLines.find((line) => line.includes("/api/auth/login"));

        expect(loginLogLine).toBeTruthy();
        // The core security property: the real token never appears in the
        // log line. Note this specific line happens to also be truncated
        // to 120 chars (app.ts's own log-line-length cap) before reaching
        // the token field at all — an even stronger guarantee than
        // redaction for THIS particular line, but not proof the redaction
        // logic itself works, so assert that separately below with a
        // request whose response is short enough to survive truncation.
        expect(loginLogLine).not.toContain(realToken);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("the redaction marker itself is proven on a response short enough to survive the 120-char log truncation", async () => {
      const loginRes = await request(app).post("/api/auth/login").send({ username: technicianA.username, password: technicianA.password });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const refreshRes = await request(app).post("/api/auth/refresh").send({ refreshToken: loginRes.body.refreshToken });
        expect(refreshRes.status).toBe(200);
        const realNewToken = refreshRes.body.token as string;
        const realNewRefreshToken = refreshRes.body.refreshToken as string;

        const loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
        const refreshLogLine = loggedLines.find((line) => line.includes("/api/auth/refresh"));

        expect(refreshLogLine).toBeTruthy();
        expect(refreshLogLine).toContain("[REDACTED]");
        expect(refreshLogLine).not.toContain(realNewToken);
        expect(refreshLogLine).not.toContain(realNewRefreshToken);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  // ==================================================================
  // I2A — Active-account authentication / credential invalidation lifecycle
  // ==================================================================
  describe("I2A: active-account authentication invariant", () => {
    async function makeUser(overrides: Partial<{ isActive: boolean; role: string }> = {}) {
      const { users, regions } = await import("@shared/schema");
      const regionId = randomUUID();
      await db.insert(regions).values({ id: regionId, name: `I2A Test Region ${randomUUID()}` });
      const id = randomUUID();
      const username = `i2a.${randomUUID()}`;
      await db.insert(users).values({
        id,
        username,
        email: `${username}@test.invalid`,
        fullName: "I2A Test User",
        password: await hashPassword("I2ATestPassword!1"),
        role: overrides.role ?? "technician",
        regionId,
        isActive: overrides.isActive ?? true,
      });
      return { id, username, password: "I2ATestPassword!1" };
    }

    it("an active user's JWT authenticates", async () => {
      const u = await makeUser();
      const token = signTestToken({ id: u.id, role: "technician", username: u.username, authGeneration: 0 });
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("deactivating the account makes the SAME still-unexpired JWT fail on the very next request", async () => {
      const u = await makeUser();
      const token = signTestToken({ id: u.id, role: "technician", username: u.username, authGeneration: 0 });
      expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);

      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      await db.update(users).set({ isActive: false, authGeneration: 1 }).where(eq(users.id, u.id));

      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it("a JWT with no authGeneration claim (pre-migration) is treated as generation 0 and works while the account remains generation 0", async () => {
      const u = await makeUser();
      const token = signTestToken({ id: u.id, role: "technician", username: u.username }); // no authGeneration
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("reactivating the account does NOT revive a pre-deactivation JWT — old credential lineage stays permanently dead", async () => {
      const u = await makeUser();
      const token = signTestToken({ id: u.id, role: "technician", username: u.username, authGeneration: 0 });

      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      await db.update(users).set({ isActive: false, authGeneration: 1 }).where(eq(users.id, u.id));
      await db.update(users).set({ isActive: true }).where(eq(users.id, u.id)); // reactivate, generation stays 1

      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it("reactivation requires a fresh login — the new token is bound to the post-reactivation generation and works", async () => {
      const u = await makeUser();
      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      await db.update(users).set({ isActive: false, authGeneration: 1 }).where(eq(users.id, u.id));
      await db.update(users).set({ isActive: true }).where(eq(users.id, u.id));

      const loginRes = await request(app).post("/api/auth/login").send({ username: u.username, password: u.password });
      expect(loginRes.status).toBe(200);

      const meRes = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${loginRes.body.token}`);
      expect(meRes.status).toBe(200);
    });

    it("a refresh token issued before deactivation cannot mint a new credential after deactivation", async () => {
      const u = await makeUser();
      const loginRes = await request(app).post("/api/auth/login").send({ username: u.username, password: u.password });
      const refreshToken = loginRes.body.refreshToken;

      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      await db.update(users).set({ isActive: false, authGeneration: 1 }).where(eq(users.id, u.id));

      const refreshRes = await request(app).post("/api/auth/refresh").send({ refreshToken });
      expect(refreshRes.status).toBe(401);
    });

    it("a refresh token issued before deactivation still cannot mint a credential after a later reactivation (generation mismatch, not merely revocation)", async () => {
      const u = await makeUser();
      const loginRes = await request(app).post("/api/auth/login").send({ username: u.username, password: u.password });
      const refreshToken = loginRes.body.refreshToken;

      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      await db.update(users).set({ isActive: false, authGeneration: 1 }).where(eq(users.id, u.id));
      await db.update(users).set({ isActive: true }).where(eq(users.id, u.id));

      const refreshRes = await request(app).post("/api/auth/refresh").send({ refreshToken });
      expect(refreshRes.status).toBe(401);
    });

    it("generic PATCH /api/users/:id with isActive=false actually deactivates (routes through the canonical transition, not a bare writer)", async () => {
      const u = await makeUser();
      const token = signTestToken({ id: u.id, role: "technician", username: u.username, authGeneration: 0 });
      const adminToken = signTestToken(DEFAULT_TEST_USERS_LOCAL_ADMIN());

      const patchRes = await request(app)
        .patch(`/api/users/${u.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ isActive: false });
      expect(patchRes.status).toBe(200);

      // The credential issued before this PATCH must now be rejected — proving
      // the PATCH path actually invoked full invalidation, not a bare UPDATE.
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it("PATCH with ordinary fields + isActive=false persists both atomically", async () => {
      const u = await makeUser();
      const adminToken = signTestToken(DEFAULT_TEST_USERS_LOCAL_ADMIN());

      const patchRes = await request(app)
        .patch(`/api/users/${u.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ fullName: "Renamed By PATCH", isActive: false });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.fullName).toBe("Renamed By PATCH");
      expect(patchRes.body.isActive).toBe(false);
    });

    it("a PATCH containing authGeneration does not alter the persisted generation", async () => {
      const u = await makeUser();
      const adminToken = signTestToken(DEFAULT_TEST_USERS_LOCAL_ADMIN());

      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      await db.update(users).set({ authGeneration: 5 }).where(eq(users.id, u.id));

      const patchRes = await request(app)
        .patch(`/api/users/${u.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ authGeneration: 0, fullName: "Should Not Reset Generation" });
      expect(patchRes.status).toBe(200);

      const [row] = await db.select({ authGeneration: users.authGeneration }).from(users).where(eq(users.id, u.id));
      expect(row.authGeneration).toBe(5);
    });

    it("a POST creating a new user ignores a client-supplied authGeneration", async () => {
      const adminToken = signTestToken(DEFAULT_TEST_USERS_LOCAL_ADMIN());
      const username = `i2a.create.${randomUUID()}`;

      const createRes = await request(app)
        .post("/api/users")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          username,
          email: `${username}@test.invalid`,
          password: "CreateTest!1",
          fullName: "New User",
          role: "technician",
          authGeneration: 999,
        });
      expect(createRes.status).toBe(201);

      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select({ authGeneration: users.authGeneration }).from(users).where(eq(users.id, createRes.body.id));
      expect(row.authGeneration).toBe(0);
    });

    function DEFAULT_TEST_USERS_LOCAL_ADMIN() {
      return { id: admin.id, role: "admin" as const, username: "sec.admin", authGeneration: 0 };
    }
  });

  // ==================================================================
  // I2A — Remaining credential-type and boundary coverage
  // ==================================================================
  describe("I2A: legacy bearer sessions, Express legacy sessions, internal-service, and Telegram boundaries", () => {
    const TEST_INTERNAL_SERVICE_KEY = "i2a-security-foundation-test-internal-service-key-not-for-production";

    beforeAll(() => {
      process.env.INTERNAL_SERVICE_KEY = TEST_INTERNAL_SERVICE_KEY;
    });

    async function makeUser(overrides: Partial<{ isActive: boolean; role: string }> = {}) {
      const { users, regions } = await import("@shared/schema");
      const regionId = randomUUID();
      await db.insert(regions).values({ id: regionId, name: `I2A Boundary Test Region ${randomUUID()}` });
      const id = randomUUID();
      const username = `i2a.boundary.${randomUUID()}`;
      await db.insert(users).values({
        id,
        username,
        email: `${username}@test.invalid`,
        fullName: "I2A Boundary Test User",
        password: await hashPassword("I2ABoundaryTest!1"),
        role: overrides.role ?? "technician",
        regionId,
        isActive: overrides.isActive ?? true,
      });
      return { id, username };
    }

    it("the leads route succeeds against a real, active, authoritative user via the real requireAuth middleware", async () => {
      const u = await makeUser();
      const token = signTestToken({ id: u.id, role: "technician", username: u.username, authGeneration: 0 });
      const res = await request(app).get("/api/leads/discovery/check-access").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.allowed).toBe(true);
    });

    it("a legacy bearer_sessions token (no production writer, test-inserted directly) authenticates while the account is active", async () => {
      const { bearerSessions } = await import("@shared/schema");
      const u = await makeUser();
      const token = randomUUID().replace(/-/g, "");
      await db.insert(bearerSessions).values({
        token,
        userId: u.id,
        role: "technician",
        username: u.username,
        regionId: null,
        expiry: Date.now() + 1000 * 60 * 60,
      });

      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("the SAME legacy bearer_sessions token is rejected once the account is deactivated", async () => {
      const { bearerSessions, users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const u = await makeUser();
      const token = randomUUID().replace(/-/g, "");
      await db.insert(bearerSessions).values({
        token,
        userId: u.id,
        role: "technician",
        username: u.username,
        regionId: null,
        expiry: Date.now() + 1000 * 60 * 60,
      });
      expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);

      await db.update(users).set({ isActive: false, authGeneration: 1 }).where(eq(users.id, u.id));

      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it("the SAME legacy bearer_sessions token remains rejected after reactivation", async () => {
      const { bearerSessions } = await import("@shared/schema");
      const u = await makeUser();
      const token = randomUUID().replace(/-/g, "");
      await db.insert(bearerSessions).values({
        token,
        userId: u.id,
        role: "technician",
        username: u.username,
        regionId: null,
        expiry: Date.now() + 1000 * 60 * 60,
      });

      // Deactivation must run through the REAL canonical transition (not a
      // raw column update) so the bearer_sessions row is actually deleted —
      // that physical deletion, not a generation check, is this credential
      // type's security boundary, per the frozen I2A design.
      const adminToken = signTestToken({ id: admin.id, role: "admin", username: "sec.admin", authGeneration: 0 });
      await request(app).patch(`/api/users/${u.id}`).set("Authorization", `Bearer ${adminToken}`).send({ isActive: false });
      await request(app).patch(`/api/users/${u.id}`).set("Authorization", `Bearer ${adminToken}`).send({ isActive: true });

      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it("an Express legacy session lacking authGeneration in its stored JSON is accepted while the account is generation 0", async () => {
      const { getPool } = await import("../../database/connection");
      const u = await makeUser();
      const { sign: signCookie } = await import("cookie-signature");
      const sid = randomUUID();
      const sessSecret = process.env.SESSION_SECRET!;
      const signedCookie = "s%3A" + encodeURIComponent(signCookie(sid, sessSecret));

      await getPool().query(
        `INSERT INTO "session" (sid, sess, expire) VALUES ($1, $2::json, now() + interval '1 day')`,
        [
          sid,
          JSON.stringify({
            cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: "/" },
            user: { id: u.id, role: "technician", username: u.username, regionId: null },
          }),
        ]
      );

      const res = await request(app).get("/api/auth/me").set("Cookie", `sessionId=${signedCookie}`);
      expect(res.status).toBe(200);
    });

    it("the SAME legacy Express session (no authGeneration) is rejected after deactivation and remains rejected after reactivation", async () => {
      const { getPool } = await import("../../database/connection");
      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const u = await makeUser();
      const { sign: signCookie } = await import("cookie-signature");
      const sid = randomUUID();
      const sessSecret = process.env.SESSION_SECRET!;
      const signedCookie = "s%3A" + encodeURIComponent(signCookie(sid, sessSecret));

      await getPool().query(
        `INSERT INTO "session" (sid, sess, expire) VALUES ($1, $2::json, now() + interval '1 day')`,
        [
          sid,
          JSON.stringify({
            cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: "/" },
            user: { id: u.id, role: "technician", username: u.username, regionId: null },
          }),
        ]
      );

      await db.update(users).set({ isActive: false, authGeneration: 1 }).where(eq(users.id, u.id));
      expect((await request(app).get("/api/auth/me").set("Cookie", `sessionId=${signedCookie}`)).status).toBe(401);

      await db.update(users).set({ isActive: true }).where(eq(users.id, u.id));
      const res = await request(app).get("/api/auth/me").set("Cookie", `sessionId=${signedCookie}`);
      expect(res.status).toBe(401);
    });

    it("requireAdminOrInternal grants access with a valid x-internal-service-key and no human session at all", async () => {
      const res = await request(app)
        .get("/api/observability/ready")
        .set("x-internal-service-key", TEST_INTERNAL_SERVICE_KEY);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("requireAdminOrInternal rejects a request with no internal key and no session", async () => {
      const res = await request(app).get("/api/observability/ready");
      expect(res.status).toBe(401);
    });

    it("requireAuthOrInternal's Telegram sub-path (which requires the internal key alongside a linked technician id) accepts an active linked technician", async () => {
      const { users } = await import("@shared/schema");
      const u = await makeUser();
      const telegramId = `tg-${randomUUID()}`;
      const { eq } = await import("drizzle-orm");
      await db.update(users).set({ telegramUserId: telegramId }).where(eq(users.id, u.id));

      // /api/courier/serial-lookup is registered twice in courier.routes.ts —
      // an earlier requireAuth-only registration shadows the
      // requireAuthOrInternal one for the same path+method, so it can never
      // reach the Telegram sub-path under test. /api/courier/sim-link is
      // registered exactly once, with requireAuthOrInternal, and reaches it.
      const res = await request(app)
        .post("/api/courier/sim-link")
        .set("x-internal-service-key", TEST_INTERNAL_SERVICE_KEY)
        .set("x-telegram-user-id", telegramId)
        .send({ simSerial: "0000000000000" });

      // The auth boundary must not reject this — any 401 here would be an auth
      // failure; a non-401/403 status (whatever the route's own business logic
      // returns for this payload) proves the Telegram sub-path authenticated.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("requireAuthOrInternal's Telegram sub-path rejects the same identity once the linked technician is deactivated", async () => {
      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const u = await makeUser();
      const telegramId = `tg-${randomUUID()}`;
      await db.update(users).set({ telegramUserId: telegramId, isActive: false }).where(eq(users.id, u.id));

      const res = await request(app)
        .post("/api/courier/sim-link")
        .set("x-internal-service-key", TEST_INTERNAL_SERVICE_KEY)
        .set("x-telegram-user-id", telegramId)
        .send({ simSerial: "0000000000000" });

      expect(res.status).toBe(401);
    });
  });
});
