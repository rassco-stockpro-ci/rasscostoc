import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Production parity regression: the platform lock gate that runs in
// Production must keep its contract once main is deployed — allowlisted
// paths always pass, ACTIVE passes, any other mode (or an unreadable state)
// answers 503 PLATFORM_LOCKED, HTML for browsers, JSON for the API.
const state = vi.hoisted(() => ({
  current: { mode: "ACTIVE", source: "db", systemLockVersion: 0 } as any,
  refreshThrows: false,
}));

vi.mock("./platform-lock.service", () => ({
  platformLockService: {
    getCachedState: () => state.current,
    refresh: async () => {
      if (state.refreshThrows) throw new Error("db down");
      return state.current;
    },
    isActive: (s: any) => s.mode === "ACTIVE",
    getPublicMessage: (s: any) => s.publicMessage ?? "",
  },
}));

import { platformLockMiddleware } from "./platform-lock.middleware";
import { isPlatformLockAllowlistedPath } from "./platform-lock.paths";

function app() {
  const a = express();
  a.use(platformLockMiddleware);
  a.get("/api/health", (_req, res) => res.json({ ok: true }));
  a.get("/api/platform-lock/public-status", (_req, res) => res.json({ ok: true }));
  a.get("/api/courier/requests", (_req, res) => res.json({ ok: true }));
  a.get("/courier/requests", (_req, res) => res.send("<html>portal</html>"));
  return a;
}

describe("platform lock gate (production parity)", () => {
  beforeEach(() => {
    state.current = { mode: "ACTIVE", source: "db", systemLockVersion: 0 };
    state.refreshThrows = false;
  });

  it("ACTIVE: business routes pass through", async () => {
    await request(app()).get("/api/courier/requests").expect(200);
  });

  it("locked: API routes answer 503 PLATFORM_LOCKED with the public message", async () => {
    state.current = { mode: "SUSPENDED", source: "db", publicMessage: "contact owner", systemLockVersion: 3 };
    const res = await request(app()).get("/api/courier/requests").expect(503);
    expect(res.body).toMatchObject({ error: "PLATFORM_LOCKED", mode: "SUSPENDED", message: "contact owner" });
    expect(res.headers["x-platform-lock-mode"]).toBe("SUSPENDED");
    expect(res.headers["retry-after"]).toBe("300");
  });

  it("locked: browser navigation gets the maintenance HTML page (message escaped)", async () => {
    state.current = { mode: "MAINTENANCE", source: "db", publicMessage: "<b>x</b>", systemLockVersion: 1 };
    const res = await request(app()).get("/courier/requests").set("Accept", "text/html").expect(503);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("locked: health and owner/platform-lock routes stay reachable", async () => {
    state.current = { mode: "SUSPENDED", source: "db", systemLockVersion: 3 };
    await request(app()).get("/api/health").expect(200);
    await request(app()).get("/api/platform-lock/public-status").expect(200);
  });

  it("unreadable state fails closed (503), never open", async () => {
    state.current = { mode: "ACTIVE", source: "fail-closed-default", systemLockVersion: 0 };
    state.refreshThrows = true;
    const res = await request(app()).get("/api/courier/requests").expect(503);
    expect(res.body.error).toBe("PLATFORM_LOCKED");
  });

  it("allowlist covers health, maintenance, platform-lock and observability only", () => {
    for (const p of ["/health", "/api/health", "/maintenance", "/api/platform-lock", "/api/platform-lock/status", "/api/observability/client-timing"]) {
      expect(isPlatformLockAllowlistedPath(p)).toBe(true);
    }
    for (const p of ["/api/courier/requests", "/api/platform-lockx", "/api/auth/login", "/"]) {
      expect(isPlatformLockAllowlistedPath(p)).toBe(false);
    }
  });
});
