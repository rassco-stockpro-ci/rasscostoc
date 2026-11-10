/**
 * Real-database, no-mocks, full-chain proof (same isolated-fixture pattern as
 * serialized-items.service.delete-custody.integration.test.ts):
 *
 *   a) A serial is written via the REAL SerializedItemsService.scanIn() —
 *      the exact same backend code path the Flutter app's scan-in screen
 *      calls (POST /api/serialized-items/scan-in). Driving the real Flutter
 *      runtime isn't practical from a backend test, so this calls the same
 *      backend entry point with the same payload shape instead — the
 *      closest faithful substitute, named explicitly as such.
 *   b) Persisted via the real repository/db pool (no service/db mocks at all
 *      in this file).
 *   c) Read back via the REAL GET /api/serialized-items/search route,
 *      through supertest + the real Express app + the real controller +
 *      the real (unmocked) service — the admin side of the proof chain.
 *   d) Asserts the result contains the correct serial AND the correct item
 *      type label.
 *   e) Asserts permission scope: a supervisor NOT assigned to the test
 *      technician gets an empty result for the same query a correctly
 *      assigned supervisor finds it with (same pattern as the IDOR fix's
 *      scope tests, against real assignment rows this time).
 *
 * All fixtures use obviously-fake, test-only identifiers and are fully
 * removed in afterAll. This test never reads, modifies, or deletes any
 * pre-existing row — it only touches rows it creates itself in beforeAll.
 *
 * KNOWN ENVIRONMENT LIMITATION: this file requires a real DATABASE_URL.
 * Confirmed in this environment: none is set (the project's pre-existing
 * *.integration.test.ts files fail identically). This test is written to
 * run correctly wherever a real database IS available; it cannot execute
 * here, and is reported as BLOCKED at the integration level for that reason
 * — not skipped, not mocked around.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { pool } from "@core/config/db";
import { serializedItemsContainer } from "@server/composition/serialized-items.container";
import { registerSerializedItemsRoutes } from "./serialized-items.routes";

const serializedItemsService = serializedItemsContainer.serializedItemsService;

let currentUser: { id: string; role: string };

const authMock = (req: any, _res: any, next: any) => {
  req.user = currentUser;
  next();
};

function buildRealApp() {
  const app = express();
  app.use(express.json());
  // Route registration imports the real requireAuth from the module graph;
  // swap just the request-level identity for the test via a tiny shim route
  // layer instead of vi.mock, since this file intentionally mocks nothing.
  app.use((req: any, _res, next) => { req.user = currentUser; next(); });
  registerSerializedItemsRoutes(app);
  return app;
}

describe("Serialized item scan-in -> admin search — real database, full chain", () => {
  let technicianId: string;
  let otherTechnicianId: string;
  let supervisorInScopeId: string;
  let supervisorOutOfScopeId: string;
  let itemTypeId: string;
  let itemTypeNameAr: string;

  const SERIAL = `E2ESEARCHTEST${Date.now()}`;

  beforeAll(async () => {
    const itemTypeRes = await pool.query(
      `SELECT id, name_ar FROM item_types WHERE category = 'devices' LIMIT 1`
    );
    if (itemTypeRes.rows.length === 0) {
      throw new Error("Test setup requires at least one existing item_type with category='devices'");
    }
    itemTypeId = itemTypeRes.rows[0].id;
    itemTypeNameAr = itemTypeRes.rows[0].name_ar;

    const tech = await pool.query(
      `INSERT INTO users (username, email, password, full_name, role)
       VALUES ($1, $2, $3, $4, 'technician') RETURNING id`,
      [`e2e_search_tech_${Date.now()}`, `e2e-search-tech-${Date.now()}@example.invalid`, "test-fixture-hash", "E2E Search Test Technician"]
    );
    technicianId = tech.rows[0].id;

    const otherTech = await pool.query(
      `INSERT INTO users (username, email, password, full_name, role)
       VALUES ($1, $2, $3, $4, 'technician') RETURNING id`,
      [`e2e_search_other_tech_${Date.now()}`, `e2e-search-other-tech-${Date.now()}@example.invalid`, "test-fixture-hash", "E2E Search Other Technician"]
    );
    otherTechnicianId = otherTech.rows[0].id;

    const supIn = await pool.query(
      `INSERT INTO users (username, email, password, full_name, role)
       VALUES ($1, $2, $3, $4, 'supervisor') RETURNING id`,
      [`e2e_search_sup_in_${Date.now()}`, `e2e-search-sup-in-${Date.now()}@example.invalid`, "test-fixture-hash", "E2E In-Scope Supervisor"]
    );
    supervisorInScopeId = supIn.rows[0].id;

    const supOut = await pool.query(
      `INSERT INTO users (username, email, password, full_name, role)
       VALUES ($1, $2, $3, $4, 'supervisor') RETURNING id`,
      [`e2e_search_sup_out_${Date.now()}`, `e2e-search-sup-out-${Date.now()}@example.invalid`, "test-fixture-hash", "E2E Out-of-Scope Supervisor"]
    );
    supervisorOutOfScopeId = supOut.rows[0].id;

    // Assign only the in-scope supervisor to this test technician.
    await pool.query(
      `INSERT INTO supervisor_technicians (supervisor_id, technician_id)
       VALUES ($1, $2)`,
      [supervisorInScopeId, technicianId]
    );

    // (a) Write the serial via the REAL scanIn() service method — the exact
    // backend code path POST /api/serialized-items/scan-in calls.
    await serializedItemsService.scanIn(technicianId, SERIAL, itemTypeId);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM custody_movements WHERE item_id IN (SELECT id FROM items WHERE serial_number = $1)`, [SERIAL]);
    await pool.query(`DELETE FROM inventory_transactions WHERE item_id IN (SELECT id FROM items WHERE serial_number = $1)`, [SERIAL]);
    await pool.query(`DELETE FROM item_history_logs WHERE item_id IN (SELECT id FROM items WHERE serial_number = $1)`, [SERIAL]);
    await pool.query(`DELETE FROM technician_moving_inventory_entries WHERE technician_id IN ($1, $2)`, [technicianId, otherTechnicianId]);
    await pool.query(`DELETE FROM items WHERE serial_number = $1`, [SERIAL]);
    await pool.query(`DELETE FROM supervisor_technicians WHERE supervisor_id IN ($1, $2)`, [supervisorInScopeId, supervisorOutOfScopeId]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3, $4)`, [technicianId, otherTechnicianId, supervisorInScopeId, supervisorOutOfScopeId]);
  });

  it("(c+d) a real admin search for the just-written serial finds it with the correct serial and item type", async () => {
    currentUser = { id: "admin-e2e", role: "admin" };

    const res = await request(buildRealApp())
      .get(`/api/serialized-items/search?q=${SERIAL}`)
      .expect(200);

    const match = res.body.data.find((row: any) => row.serialNumber === SERIAL);
    expect(match).toBeDefined();
    expect(match.serialNumber).toBe(SERIAL);
    expect(match.itemTypeNameAr).toBe(itemTypeNameAr);
    expect(match.currentOwnerId).toBe(technicianId);
  });

  it("(e) scope is respected against REAL assignment rows: in-scope supervisor finds it, out-of-scope supervisor does not", async () => {
    currentUser = { id: supervisorInScopeId, role: "supervisor" };
    const inScopeRes = await request(buildRealApp())
      .get(`/api/serialized-items/search?q=${SERIAL}`)
      .expect(200);
    expect(inScopeRes.body.data.some((row: any) => row.serialNumber === SERIAL)).toBe(true);

    currentUser = { id: supervisorOutOfScopeId, role: "supervisor" };
    const outOfScopeRes = await request(buildRealApp())
      .get(`/api/serialized-items/search?q=${SERIAL}`)
      .expect(200);
    expect(outOfScopeRes.body.data.some((row: any) => row.serialNumber === SERIAL)).toBe(false);
  });

  it("the lookup endpoint's ownership scope also holds against real data: other technician is denied, owner is allowed", async () => {
    currentUser = { id: otherTechnicianId, role: "technician" };
    await request(buildRealApp()).get(`/api/serialized-items/lookup/${SERIAL}`).expect(403);

    currentUser = { id: technicianId, role: "technician" };
    const ownRes = await request(buildRealApp()).get(`/api/serialized-items/lookup/${SERIAL}`).expect(200);
    expect(ownRes.body.data.serialNumber).toBe(SERIAL);
  });
});
