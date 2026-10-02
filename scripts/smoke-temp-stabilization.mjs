#!/usr/bin/env node
/**
 * TEMP-SYSTEM-STABILIZATION-F2 — permanent, non-destructive smoke script.
 *
 * Run this directly after any deployment: `npm run smoke:temp` (or
 * `BASE_URL=https://nuzum.fun node scripts/smoke-temp-stabilization.mjs`).
 *
 * Everything here is read-only / unauthenticated — no login, no production
 * data mutation, safe to run repeatedly against a live environment.
 */

const BASE_URL = process.env.BASE_URL || "https://nuzum.fun";
const FANI_URL = process.env.FANI_URL || "https://fani.nuzum.fun";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log(`\nTEMP-SYSTEM-STABILIZATION smoke check — ${BASE_URL}\n`);

  console.log("Server health & page loads:");
  await check("portal root responds 200", async () => {
    const res = await fetch(`${BASE_URL}/`);
    assert(res.status === 200, `got ${res.status}`);
  });
  await check("fani-web root responds 200", async () => {
    const res = await fetch(`${FANI_URL}/`);
    assert(res.status === 200, `got ${res.status}`);
  });

  console.log("\nAPI fallback (the root fix):");
  await check("unmatched /api/* path returns JSON 404, never HTML", async () => {
    const res = await fetch(`${BASE_URL}/api/smoke-test-nonexistent-route-${Date.now()}`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    assert(contentType.includes("application/json"), `expected application/json, got ${contentType}`);
    const body = await res.json();
    assert(body.success === false, "expected success:false");
    assert(!JSON.stringify(body).includes("<!DOCTYPE"), "response leaked HTML");
  });
  await check("normal unmatched SPA route still serves index.html (fallback not over-broadened)", async () => {
    const res = await fetch(`${BASE_URL}/smoke-test-spa-route-${Date.now()}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    assert(contentType.includes("text/html"), `expected text/html, got ${contentType}`);
  });

  console.log("\nProtected endpoints require auth (no HTML leak, no accidental 200):");
  const protectedRoutes = [
    ["DELETE", "/api/technicians/smoke-test-id"],
    ["PATCH", "/api/technicians/smoke-test-id"],
    ["PATCH", "/api/serialized-items/smoke-test-id"],
    ["DELETE", "/api/serialized-items/smoke-test-id"],
    ["PATCH", "/api/warehouse-transfers/smoke-test-id/status"],
    ["GET", "/api/technicians"],
    ["GET", "/api/admin/backup"],
  ];
  for (const [method, path] of protectedRoutes) {
    await check(`${method} ${path} -> 401 JSON (no session)`, async () => {
      const res = await fetch(`${BASE_URL}${path}`, { method });
      assert(res.status === 401, `expected 401, got ${res.status}`);
      const contentType = res.headers.get("content-type") || "";
      assert(contentType.includes("application/json"), `expected application/json, got ${contentType}`);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke script crashed:", err);
  process.exit(1);
});
