/**
 * OPS-PERM-S1-F4-R2 — last-active-admin hardening, real-Postgres proof.
 *
 * R1 (OPS_PERM_S1_F4_R1_PERMISSION_ENGINE_INDEPENDENT_REVIEW) proved two
 * blockers with fully-reproducible evidence:
 *
 *   Blocker 1 — a bare `role` PATCH (no isActive) never touched the guard at
 *   all, so a single, non-concurrent, well-formed admin request could demote
 *   the sole other active Admin's role with zero protection.
 *
 *   Blocker 2 — the guard's own "count other active admins" read was a plain,
 *   unlocked SELECT with no isolation-level or locking strategy, so two
 *   concurrent transactions targeting DIFFERENT admin rows could each read a
 *   safe count and both commit — empirically reproduced 10/10 trials against
 *   real Postgres using a third-party actor (to rule out the incidental
 *   audit-FK deadlock that had been mistaken for protection).
 *
 * This file re-runs exactly those reproductions against the FIXED code and
 * proves the invariant now holds — real Postgres, real transactions, no
 * mocks. Mock-only proof of the wiring lives in
 * UserManagement.last-active-admin.test.ts; this file is what actually backs
 * the concurrency claim.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../../core/config/db";
import { users, regions, systemLogs } from "@shared/schema";
import { hashPassword } from "../../../../utils/password";
import { UserManagementUseCase, type StatusTransitionActor } from "../../application/users/use-cases/UserManagement.use-case";
import { DrizzleUserRepository } from "../database/DrizzleUserRepository";
import { DrizzleIdentityUnitOfWork } from "./DrizzleIdentityUnitOfWork";

  /**
   * ROOT CAUSE of a cross-file test-isolation regression (found via live reproduction and a direct
   * data probe): RESTART IDENTITY applies to every table TRUNCATE actually empties in one statement,
   * including ones pulled in only by CASCADE -- not just the five named here. courier_requests.
   * created_by references users.id, so CASCADE also truncates courier_requests, and RESTART IDENTITY
   * was also resetting courier_requests' id sequence back to 1. A later test's brand-new request
   * could then reuse a low id an EARLIER, unrelated test's orphaned outbox_events row (no FK to
   * courier_requests, never cleaned up by any test) still held in its JSONB payload, so a query
   * filtering strictly by that exact request id returned both rows. This file's own assertions never
   * depend on users/regions/etc. restarting from a specific id (they check per-user columns like
   * authGeneration, not table-level sequence values), so CONTINUE IDENTITY clears every row exactly
   * as before with none of this side effect.
   */
async function resetTables() {
  await db.execute(
    sql.raw(`TRUNCATE TABLE "users", "regions", "refresh_tokens", "system_logs", "bearer_sessions" CONTINUE IDENTITY CASCADE`)
  );
}

async function makeUser(role: string, isActive = true) {
  const regionId = randomUUID();
  await db.insert(regions).values({ id: regionId, name: `laa-conc-${randomUUID()}` });
  const id = randomUUID();
  const username = `laa.conc.${randomUUID()}`;
  await db.insert(users).values({
    id,
    username,
    email: `${username}@test.invalid`,
    fullName: "Last-Active-Admin Concurrency Test User",
    password: await hashPassword("LaaConcTest!1"),
    role,
    regionId,
    isActive,
  });
  return { id, username };
}

function actorFrom(u: { id: string; username: string }, role: string): StatusTransitionActor {
  return { id: u.id, username: u.username, role };
}

async function auditRowCount(entityId: string): Promise<number> {
  const rows = await db.select().from(systemLogs).where(eq(systemLogs.entityId, entityId));
  return rows.length;
}

describe("OPS-PERM-S1-F4-R2: last-active-admin protection — real-Postgres concurrency proof", () => {
  let useCase: UserManagementUseCase;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    await resetTables();
  });

  beforeEach(async () => {
    useCase = new UserManagementUseCase(new DrizzleUserRepository(), new DrizzleIdentityUnitOfWork());
  });

  afterEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await resetTables();
  });

  describe("1. sole active Admin cannot be demoted via role update", () => {
    it("blocks the role PATCH, persists no role change, writes no audit row (Blocker 1, closed)", async () => {
      const admin = await makeUser("admin");
      const thirdParty = await makeUser("supervisor");
      const actor = actorFrom(thirdParty, "supervisor");

      await expect(useCase.update(admin.id, { role: "viewer" }, actor)).rejects.toThrow();

      const [row] = await db.select().from(users).where(eq(users.id, admin.id));
      expect(row.role).toBe("admin");
      expect(row.isActive).toBe(true);
      expect(await auditRowCount(admin.id)).toBe(0);
    });
  });

  describe("2. sole active Admin cannot be deactivated", () => {
    it("blocks deactivateUser, persists no isActive change, writes no audit row", async () => {
      const admin = await makeUser("admin");
      const thirdParty = await makeUser("supervisor");
      const actor = actorFrom(thirdParty, "supervisor");

      await expect(useCase.deactivateUser(admin.id, actor)).rejects.toThrow();

      const [row] = await db.select().from(users).where(eq(users.id, admin.id));
      expect(row.isActive).toBe(true);
      expect(await auditRowCount(admin.id)).toBe(0);
    });
  });

  describe("3. sole active Admin cannot be soft-deleted", () => {
    it("blocks softDelete, persists no isActive change, writes no audit row", async () => {
      const admin = await makeUser("admin");
      const thirdParty = await makeUser("supervisor");
      const actor = actorFrom(thirdParty, "supervisor");

      await expect(useCase.softDelete(admin.id, actor)).rejects.toThrow();

      const [row] = await db.select().from(users).where(eq(users.id, admin.id));
      expect(row.isActive).toBe(true);
      expect(await auditRowCount(admin.id)).toBe(0);
    });
  });

  describe("4. bulk operation cannot remove all active Admins", () => {
    it("bulkDeactivate targeting every admin rolls back the ENTIRE batch, not just the last one", async () => {
      const admin1 = await makeUser("admin");
      const admin2 = await makeUser("admin");
      const thirdParty = await makeUser("supervisor");
      const actor = actorFrom(thirdParty, "supervisor");

      await expect(useCase.bulkDeactivate(undefined, actor)).rejects.toThrow();

      const [row1] = await db.select().from(users).where(eq(users.id, admin1.id));
      const [row2] = await db.select().from(users).where(eq(users.id, admin2.id));
      // Evaluated as ONE transition set: since the whole set would reach zero active
      // admins, NEITHER admin is deactivated — not "all but the last one".
      expect(row1.isActive).toBe(true);
      expect(row2.isActive).toBe(true);
      expect(await auditRowCount(admin1.id)).toBe(0);
      expect(await auditRowCount(admin2.id)).toBe(0);
    });
  });

  describe("5. two concurrent Admin deactivations cannot leave zero Admins (Blocker 2, closed)", () => {
    it(
      "repeated trials, THIRD-PARTY actor (rules out incidental actor/target FK deadlocks masquerading as protection): never zero, exactly one survives",
      async () => {
        const TRIALS = 8;
        for (let trial = 0; trial < TRIALS; trial++) {
          // Each trial must see EXACTLY its own two admins as the entire admin
          // roster — leaving a prior trial's surviving admin in place would let
          // the guard see a stray safety margin that doesn't actually belong to
          // THIS trial's race, silently masking the very defect this test
          // exists to catch. Full reset, not a narrower delete, so no table
          // this invariant reads from (users) carries any cross-trial residue.
          await resetTables();

          const x = await makeUser("admin");
          const y = await makeUser("admin");
          const thirdParty = await makeUser("supervisor"); // distinct from both targets — see R1 finding
          const actor = actorFrom(thirdParty, "supervisor");

          const ucX = new UserManagementUseCase(new DrizzleUserRepository(), new DrizzleIdentityUnitOfWork());
          const ucY = new UserManagementUseCase(new DrizzleUserRepository(), new DrizzleIdentityUnitOfWork());

          const results = await Promise.allSettled([ucX.deactivateUser(x.id, actor), ucY.deactivateUser(y.id, actor)]);

          const [rowX] = await db.select().from(users).where(eq(users.id, x.id));
          const [rowY] = await db.select().from(users).where(eq(users.id, y.id));
          const activeLeft = [rowX, rowY].filter((r) => r.isActive).length;
          const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;

          expect(activeLeft).toBeGreaterThanOrEqual(1);
          // Exactly one of the two racing operations should have won — the other
          // must observe (via the now-serialized, fresh roster read) that
          // proceeding would remove the last admin.
          expect(fulfilledCount).toBe(1);
        }
      },
      60000
    );
  });

  describe("6. concurrent Admin deactivation + Admin role demotion cannot leave zero Admins", () => {
    it(
      "mixed operation types racing on the SAME invariant still serialize correctly, third-party actor",
      async () => {
        const TRIALS = 5;
        for (let trial = 0; trial < TRIALS; trial++) {
          await resetTables(); // see test 5's identical reasoning — no cross-trial admin residue
          const x = await makeUser("admin");
          const y = await makeUser("admin");
          const thirdParty = await makeUser("supervisor");
          const actor = actorFrom(thirdParty, "supervisor");

          const ucX = new UserManagementUseCase(new DrizzleUserRepository(), new DrizzleIdentityUnitOfWork());
          const ucY = new UserManagementUseCase(new DrizzleUserRepository(), new DrizzleIdentityUnitOfWork());

          const results = await Promise.allSettled([
            ucX.deactivateUser(x.id, actor), // isActive-based transition
            ucY.update(y.id, { role: "viewer" }, actor), // role-based transition
          ]);

          const [rowX] = await db.select().from(users).where(eq(users.id, x.id));
          const [rowY] = await db.select().from(users).where(eq(users.id, y.id));
          const stillActiveAdmins = [rowX, rowY].filter((r) => r.isActive && r.role === "admin").length;

          expect(stillActiveAdmins).toBeGreaterThanOrEqual(1);
          const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
          expect(fulfilledCount).toBe(1);
        }
      },
      60000
    );
  });

  describe("8. with multiple Admins, legitimate transitions that leave >=1 active Admin still succeed", () => {
    it("three admins, two concurrently deactivated by a third party: BOTH succeed, one admin remains", async () => {
      const x = await makeUser("admin");
      const y = await makeUser("admin");
      const z = await makeUser("admin"); // the safety margin
      const thirdParty = await makeUser("supervisor");
      const actor = actorFrom(thirdParty, "supervisor");

      const ucX = new UserManagementUseCase(new DrizzleUserRepository(), new DrizzleIdentityUnitOfWork());
      const ucY = new UserManagementUseCase(new DrizzleUserRepository(), new DrizzleIdentityUnitOfWork());

      const results = await Promise.allSettled([ucX.deactivateUser(x.id, actor), ucY.deactivateUser(y.id, actor)]);

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      const [rowX] = await db.select().from(users).where(eq(users.id, x.id));
      const [rowY] = await db.select().from(users).where(eq(users.id, y.id));
      const [rowZ] = await db.select().from(users).where(eq(users.id, z.id));
      expect(rowX.isActive).toBe(false);
      expect(rowY.isActive).toBe(false);
      expect(rowZ.isActive).toBe(true);
      expect(await auditRowCount(x.id)).toBe(1);
      expect(await auditRowCount(y.id)).toBe(1);
    });

    it("promoting a supervisor to admin never touches the invariant and always succeeds, even with zero other admins", async () => {
      const supervisor = await makeUser("supervisor");
      const thirdParty = await makeUser("viewer");
      const actor = actorFrom(thirdParty, "viewer");

      await expect(useCase.update(supervisor.id, { role: "admin" }, actor)).resolves.toBeDefined();

      const [row] = await db.select().from(users).where(eq(users.id, supervisor.id));
      expect(row.role).toBe("admin");
    });
  });

  describe("9. audit and mutation remain atomic", () => {
    it("a successful demotion writes exactly one audit row alongside the persisted role change", async () => {
      const admin = await makeUser("admin");
      const other = await makeUser("admin");
      const thirdParty = await makeUser("supervisor");
      const actor = actorFrom(thirdParty, "supervisor");
      void other;

      await useCase.update(admin.id, { role: "viewer" }, actor);

      const [row] = await db.select().from(users).where(eq(users.id, admin.id));
      expect(row.role).toBe("viewer");
      expect(await auditRowCount(admin.id)).toBe(1);

      const [auditRow] = await db.select().from(systemLogs).where(eq(systemLogs.entityId, admin.id));
      expect(auditRow.action).toBe("role-change");
    });

    it("a successful plain deactivation still writes exactly the pre-existing 'deactivate' audit action (no regression in wording)", async () => {
      const admin = await makeUser("admin");
      const other = await makeUser("admin");
      const thirdParty = await makeUser("supervisor");
      const actor = actorFrom(thirdParty, "supervisor");
      void other;

      await useCase.deactivateUser(admin.id, actor);

      const [auditRow] = await db.select().from(systemLogs).where(eq(systemLogs.entityId, admin.id));
      expect(auditRow.action).toBe("deactivate");
    });
  });
});
