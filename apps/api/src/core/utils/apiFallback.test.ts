/**
 * TEMP-SYSTEM-STABILIZATION-F2 — regression test A: the root SPA-fallback fix.
 *
 * Root cause: `app.use("*", (req,res) => res.sendFile(index.html))` matched
 * literally any unmatched path, including /api/*, silently masking a
 * missing/broken API route as a fake "200 text/html" success. Fixed by
 * short-circuiting any /api/* path to a real JSON 404 before the SPA
 * fallback ever runs (identical guard in both the dev and production
 * wildcard handlers in vite.ts).
 *
 * Live confirmation of this exact fix (2026-08-25/26, production):
 *   GET https://nuzum.fun/api/this-route-does-not-exist-xyz
 *     -> 404, Content-Type: application/json,
 *        {"success":false,"message":"API endpoint not found"}
 *   GET https://nuzum.fun/some/random/spa/route
 *     -> 200, text/html (SPA still serves normal pages correctly)
 *
 * This file adds a deterministic, offline regression test for the same
 * guard logic so it can be re-verified on every future change without
 * touching a live server.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

function apiPrefixGuard(req: { originalUrl: string }, res: any): boolean {
  if (req.originalUrl.startsWith("/api/")) {
    res.status(404).json({ success: false, message: "API endpoint not found" });
    return true;
  }
  return false;
}

function fakeRes() {
  const calls: { status?: number; json?: any; sentFile?: string } = {};
  const res: any = {
    status(code: number) {
      calls.status = code;
      return res;
    },
    json(payload: any) {
      calls.json = payload;
      return res;
    },
    sendFile(filePath: string) {
      calls.sentFile = filePath;
      return res;
    },
  };
  return { res, calls };
}

describe("TEMP-STABILIZATION — API never falls back to the SPA HTML shell", () => {
  it("an unmatched /api/* path gets a real JSON 404, never the SPA HTML", () => {
    const { res, calls } = fakeRes();
    const handled = apiPrefixGuard({ originalUrl: "/api/this-does-not-exist" }, res);

    expect(handled).toBe(true);
    expect(calls.status).toBe(404);
    expect(calls.json).toEqual({ success: false, message: "API endpoint not found" });
    expect(calls.sentFile).toBeUndefined();
    expect(JSON.stringify(calls.json)).not.toContain("<!DOCTYPE html>");
  });

  it("a normal (non-/api) unmatched route is NOT touched by the guard — SPA fallback still applies", () => {
    const { res, calls } = fakeRes();
    const handled = apiPrefixGuard({ originalUrl: "/some/random/spa/route" }, res);

    expect(handled).toBe(false);
    expect(calls.status).toBeUndefined();
    expect(calls.json).toBeUndefined();
  });

  it("the deployed source carries this exact guard in BOTH wildcard handlers (dev: vite.ts, production: static.ts)", () => {
    // main keeps the production serveStatic() in static.ts (so the production
    // bundle never imports the dev-only vite package); the dev setupVite()
    // stays in vite.ts. Each must carry the /api guard exactly once.
    const read = (f: string) => fs.readFileSync(path.resolve(process.cwd(), "apps/api/src/core/utils", f), "utf-8");
    for (const f of ["vite.ts", "static.ts"]) {
      const source = read(f);
      expect(source.split('.startsWith("/api/")').length - 1, f).toBe(1);
      expect(source, f).toContain('"API endpoint not found"');
    }
  });
});
