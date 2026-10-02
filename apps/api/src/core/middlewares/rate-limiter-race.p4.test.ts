import { describe, expect, it, beforeEach, afterAll } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "@core/config/db";
import { rateLimiter } from "./security.middleware";

/**
 * ERP-008 Phase 4 -- proves the rate limiter's shared Postgres counter
 * enforces one aggregate limit under concurrent callers, the same property
 * that a real multi-process deployment needs (two OutboxWorker-style
 * processes hitting the same key must never each get their own private
 * count). The genuine cross-OS-process proof lives in
 * multi-instance.p4.test.ts; this file proves the counter's atomicity at
 * the SQL level, which is the property the cross-process test depends on.
 */
describe("ERP-008 Phase 4 — rate limiter shared counter concurrency safety", () => {
  const testIp = "203.0.113.42";
  // BLOCKER #3 root cause: rateLimiter() always stores IP-keyed rows as
  // "ip:<address>" (see rateLimitKey in security.middleware.ts), but this
  // cleanup query was filtering on the bare address -- it never matched
  // the real row, so it was a silent no-op on every beforeEach/afterAll
  // call. The counter was never actually reset between the two tests in
  // this file, so "40 concurrent requests" (test 1) left the shared
  // counter at 40, and "310 concurrent requests" (test 2) then counted
  // from 41 to 350 instead of 1 to 310 -- exactly the 50-blocked/
  // 260-allowed split observed, not a defect in the counter itself
  // (confirmed separately: test 2 alone, with test 1 skipped, passes
  // cleanly at exactly 300 allowed / 10 blocked).
  const rateLimitKey = `ip:${testIp}`;

  beforeEach(async () => {
    process.env.NODE_ENV = "production";
    await db.execute(sql`DELETE FROM rate_limit_counters WHERE key = ${rateLimitKey}`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM rate_limit_counters WHERE key = ${rateLimitKey}`);
    process.env.NODE_ENV = "test";
  });

  function simulateRequest(ip: string): Promise<{ status: number; headers: Record<string, string> }> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {};
      let statusCode = 200;
      const req = { path: "/api/whatever", ip, socket: { remoteAddress: ip } } as unknown as Request;
      const res = {
        setHeader(name: string, value: string | number) { headers[name] = String(value); },
        status(code: number) { statusCode = code; return this; },
        json() { resolve({ status: statusCode, headers }); return this; },
      } as unknown as Response;
      const next: NextFunction = () => resolve({ status: 200, headers });

      rateLimiter(req, res, next).catch(() => resolve({ status: 500, headers }));
    });
  }

  it("40 concurrent requests from the same key never lose an increment", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, () => simulateRequest(testIp))
    );

    // Every response carries the remaining count computed from the shared
    // counter at the moment it was incremented. Across 40 truly-serialized
    // increments the set of "X-RateLimit-Remaining" values must be 40
    // distinct numbers (299 down to 260, against the current 300 limit --
    // if the counter lost updates under concurrency, we'd see duplicates
    // instead.
    const remaining = results.map((r) => Number(r.headers["X-RateLimit-Remaining"]));
    expect(new Set(remaining).size).toBe(40);
    for (const r of results) {
      expect(r.status).toBe(200);
    }
  });

  it("requests beyond the window limit are rejected with 429, none silently dropped", async () => {
    // ROOT FIX: MAX_REQUESTS_PER_WINDOW was raised from 150 to 300 — see
    // security.middleware.ts and security-foundation.test.ts for why.
    const total = 310; // 10 over MAX_REQUESTS_PER_WINDOW (300)
    const results = await Promise.all(
      Array.from({ length: total }, () => simulateRequest(testIp))
    );

    const ok = results.filter((r) => r.status === 200).length;
    const blocked = results.filter((r) => r.status === 429).length;

    expect(ok).toBe(300);
    expect(blocked).toBe(10);
  });
});
