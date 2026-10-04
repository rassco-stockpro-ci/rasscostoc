/**
 * OPS-PERM-S0-B1-C.I2A — Refresh/deactivation real-PostgreSQL concurrency,
 * transaction-rollback, and audit-atomicity proof.
 *
 * Lives in infrastructure/ (not application/) because it depends directly on
 * real Drizzle repositories and a real Postgres connection — the same
 * placement convention as courier-assignment-writer-concurrency.test.ts.
 * Application-layer source must never import these classes directly; this
 * suite is the one place that legitimately does.
 *
 * Every concurrency proof here uses a per-instance/per-test wrapper — never a
 * shared class-prototype patch — so tests cannot interfere with each other or
 * with any other suite sharing these classes.
 *
 * Requires a real isolated Postgres (DATABASE_URL containing "test") — same
 * refusal guard as security-foundation.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../../../../core/config/db";
import { getDatabase } from "../../../../core/database/connection";
import { users, regions, refreshTokens, systemLogs, bearerSessions } from "@shared/schema";
import { hashPassword } from "../../../../utils/password";
import { AuthService } from "../../application/auth.service";
import { UserManagementUseCase, type StatusTransitionActor } from "../../application/users/use-cases/UserManagement.use-case";
import { DrizzleUserRepository, type IdentityDbTransaction } from "../database/DrizzleUserRepository";
import { DrizzleRefreshTokenRepository } from "../database/DrizzleRefreshTokenRepository";
import { DrizzleIdentityUnitOfWork } from "./DrizzleIdentityUnitOfWork";
import { ADMIN_MEMBERSHIP_ADVISORY_LOCK_KEY } from "../../../../core/authorization/last-active-admin.guard";
import type {
  IIdentityUnitOfWork,
  IdentityTransactionalContext,
  IdentityAuditEntry,
} from "../../domain/repositories/IIdentityUnitOfWork";
import type { IRefreshTokenRepository } from "@stockpro/contracts";

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
  await db.execute(sql.raw(`TRUNCATE TABLE "users", "regions", "refresh_tokens", "system_logs", "bearer_sessions" CONTINUE IDENTITY CASCADE`));
}

async function makeActiveUser(role: string = "technician") {
  const regionId = randomUUID();
  await db.insert(regions).values({ id: regionId, name: `I2A Concurrency Region ${randomUUID()}` });
  const id = randomUUID();
  const username = `i2a.conc.${randomUUID()}`;
  await db.insert(users).values({
    id,
    username,
    email: `${username}@test.invalid`,
    fullName: "I2A Concurrency Test User",
    password: await hashPassword("ConcurrencyTest!1"),
    role,
    regionId,
    isActive: true,
  });
  return { id, username };
}

/**
 * A real Identity UoW whose transaction-scoped DrizzleUserRepository instance
 * (the one actually used for locking inside the transaction — not the
 * constructor-injected outer repository, which the use-case only uses for
 * non-transactional reads) has its lockUserForUpdate paused on the FIRST
 * call: an own-property override on that one tx-bound instance, never the
 * shared class prototype. Lets a test hold a real row lock open while a
 * second, independent transaction attempts a conflicting operation.
 */
class PausingIdentityUnitOfWork implements IIdentityUnitOfWork {
  private resolveReady!: () => void;
  private resolveRelease!: () => void;
  private backendPid: number | null = null;
  readonly ready: Promise<void>;
  private readonly releaseGate: Promise<void>;

  /**
   * If given, pauses only when THIS specific user id is locked (needed for
   * bulk operations, which lock several rows in one transaction and must
   * pause on a caller-chosen row, not merely "whichever is locked first").
   * Omit to pause on the first lock call regardless of id.
   */
  constructor(private readonly pauseOnUserId?: string) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.releaseGate = new Promise((resolve) => {
      this.resolveRelease = resolve;
    });
  }

  release(): void {
    this.resolveRelease();
  }

  getBackendPid(): number {
    if (this.backendPid === null) throw new Error("Backend PID not captured yet — await `ready` first.");
    return this.backendPid;
  }

  async execute<T>(work: (context: IdentityTransactionalContext) => Promise<T>): Promise<T> {
    const database = getDatabase();
    return database.transaction(async (tx: IdentityDbTransaction) => {
      const realUserRepository = new DrizzleUserRepository(tx);
      const originalLock = realUserRepository.lockUserForUpdate.bind(realUserRepository);
      let paused = false;
      const pausingLock = async (id: string) => {
        const result = await originalLock(id);
        const shouldPause = !paused && (this.pauseOnUserId === undefined || this.pauseOnUserId === id);
        if (shouldPause) {
          paused = true;
          const pidResult: any = await tx.execute(sql`select pg_backend_pid() as pid`);
          this.backendPid = pidResult.rows[0].pid;
          this.resolveReady();
          await this.releaseGate;
        }
        return result;
      };

      const refreshTokenRepository = new DrizzleRefreshTokenRepository(tx);
      const context: IdentityTransactionalContext = {
        userRepository: realUserRepository,
        refreshTokenRepository,
        lockUserForUpdate: pausingLock,
        updateUserState: (id, state) => realUserRepository.updateUserState(id, state),
        updateUserRole: (id, role) => realUserRepository.updateUserRole(id, role),
        acquireAdminMembershipLock: async () => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_MEMBERSHIP_ADVISORY_LOCK_KEY})`);
        },
        async deleteBearerSessionsForUser(userId: string) {
          await tx.delete(bearerSessions).where(eq(bearerSessions.userId, userId));
        },
        async deleteExpressSessionsForUser(userId: string) {
          await tx.execute(sql`DELETE FROM "session" WHERE (sess::jsonb) -> 'user' ->> 'id' = ${userId}`);
        },
        async writeAudit(entry: IdentityAuditEntry) {
          await tx.insert(systemLogs).values({
            userId: entry.userId,
            userName: entry.userName,
            userRole: entry.userRole,
            regionId: null,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            entityName: entry.entityName,
            description: entry.description,
            severity: entry.severity,
            success: entry.success,
          });
        },
      };
      return work(context);
    });
  }
}

/** Polls pg_blocking_pids() until it reports `expectedBlocker` is blocking `blockedPid`. */
async function waitUntilBlockedBy(blockedPid: number, expectedBlocker: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await pool.query(`select pg_blocking_pids($1::int) as blockers`, [blockedPid]);
    const blockers: number[] = result.rows[0]?.blockers ?? [];
    if (blockers.includes(expectedBlocker)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for pid ${blockedPid} to be blocked by pid ${expectedBlocker}`);
}

/**
 * Wraps IRefreshTokenRepository so its create() call pauses on an explicit
 * barrier — used to prove the paused-login race without any production hook.
 * A per-test-instance decorator, not a prototype/global patch.
 */
function wrapRefreshRepositoryPausingOnCreate(real: IRefreshTokenRepository): {
  wrapped: IRefreshTokenRepository;
  ready: Promise<void>;
  release: () => void;
} {
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let resolveRelease: () => void;
  const releaseGate = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  const wrapped: IRefreshTokenRepository = {
    ...real,
    create: async (token, userId, expiry, authGeneration) => {
      resolveReady();
      await releaseGate;
      return real.create(token, userId, expiry, authGeneration);
    },
  };
  return { wrapped, ready, release: () => resolveRelease() };
}

/**
 * A real Identity UoW whose writeAudit performs the real INSERT and THEN
 * throws — proving that a failure occurring strictly after the audit row is
 * written inside the same transaction still rolls the audit row back with
 * everything else. A second variant fails a given ordinary repository
 * primitive after N calls, for the bulk-rollback proof.
 */
class FaultAfterAuditIdentityUnitOfWork implements IIdentityUnitOfWork {
  async execute<T>(work: (context: IdentityTransactionalContext) => Promise<T>): Promise<T> {
    const database = getDatabase();
    return database.transaction(async (tx: IdentityDbTransaction) => {
      const userRepository = new DrizzleUserRepository(tx);
      const refreshTokenRepository = new DrizzleRefreshTokenRepository(tx);
      const context: IdentityTransactionalContext = {
        userRepository,
        refreshTokenRepository,
        lockUserForUpdate: (id) => userRepository.lockUserForUpdate(id),
        updateUserState: (id, state) => userRepository.updateUserState(id, state),
        updateUserRole: (id, role) => userRepository.updateUserRole(id, role),
        acquireAdminMembershipLock: async () => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_MEMBERSHIP_ADVISORY_LOCK_KEY})`);
        },
        async deleteBearerSessionsForUser(userId: string) {
          await tx.delete(bearerSessions).where(eq(bearerSessions.userId, userId));
        },
        async deleteExpressSessionsForUser(userId: string) {
          await tx.execute(sql`DELETE FROM "session" WHERE (sess::jsonb) -> 'user' ->> 'id' = ${userId}`);
        },
        async writeAudit(entry: IdentityAuditEntry) {
          await tx.insert(systemLogs).values({
            userId: entry.userId,
            userName: entry.userName,
            userRole: entry.userRole,
            regionId: null,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            entityName: entry.entityName,
            description: entry.description,
            severity: entry.severity,
            success: entry.success,
          });
          // The audit INSERT above has genuinely reached the open transaction.
          // This controlled failure occurs strictly AFTER it, before commit.
          throw new Error("controlled test failure after audit insert");
        },
      };
      return work(context);
    });
  }
}

class FaultAfterOrdinaryUpdateIdentityUnitOfWork implements IIdentityUnitOfWork {
  async execute<T>(work: (context: IdentityTransactionalContext) => Promise<T>): Promise<T> {
    const database = getDatabase();
    return database.transaction(async (tx: IdentityDbTransaction) => {
      const realUserRepository = new DrizzleUserRepository(tx);
      const refreshTokenRepository = new DrizzleRefreshTokenRepository(tx);
      const context: IdentityTransactionalContext = {
        userRepository: realUserRepository,
        refreshTokenRepository,
        lockUserForUpdate: (id) => realUserRepository.lockUserForUpdate(id),
        updateUserState: async () => {
          throw new Error("controlled test failure after ordinary field write");
        },
        updateUserRole: (id, role) => realUserRepository.updateUserRole(id, role),
        acquireAdminMembershipLock: async () => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_MEMBERSHIP_ADVISORY_LOCK_KEY})`);
        },
        async deleteBearerSessionsForUser(userId: string) {
          await tx.delete(bearerSessions).where(eq(bearerSessions.userId, userId));
        },
        async deleteExpressSessionsForUser(userId: string) {
          await tx.execute(sql`DELETE FROM "session" WHERE (sess::jsonb) -> 'user' ->> 'id' = ${userId}`);
        },
        async writeAudit(entry: IdentityAuditEntry) {
          await tx.insert(systemLogs).values({
            userId: entry.userId,
            userName: entry.userName,
            userRole: entry.userRole,
            regionId: null,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            entityName: entry.entityName,
            description: entry.description,
            severity: entry.severity,
            success: entry.success,
          });
        },
      };
      return work(context);
    });
  }
}

/** Fails updateUserState on the Nth call within the transaction — for the bulk-rollback proof. */
class FaultOnNthUpdateIdentityUnitOfWork implements IIdentityUnitOfWork {
  constructor(private readonly failOnCallNumber: number) {}
  async execute<T>(work: (context: IdentityTransactionalContext) => Promise<T>): Promise<T> {
    const database = getDatabase();
    let callCount = 0;
    return database.transaction(async (tx: IdentityDbTransaction) => {
      const realUserRepository = new DrizzleUserRepository(tx);
      const refreshTokenRepository = new DrizzleRefreshTokenRepository(tx);
      const context: IdentityTransactionalContext = {
        userRepository: realUserRepository,
        refreshTokenRepository,
        lockUserForUpdate: (id) => realUserRepository.lockUserForUpdate(id),
        updateUserState: async (id, state) => {
          callCount += 1;
          if (callCount === this.failOnCallNumber) {
            throw new Error(`controlled test failure on call ${callCount}`);
          }
          return realUserRepository.updateUserState(id, state);
        },
        updateUserRole: (id, role) => realUserRepository.updateUserRole(id, role),
        acquireAdminMembershipLock: async () => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMIN_MEMBERSHIP_ADVISORY_LOCK_KEY})`);
        },
        async deleteBearerSessionsForUser(userId: string) {
          await tx.delete(bearerSessions).where(eq(bearerSessions.userId, userId));
        },
        async deleteExpressSessionsForUser(userId: string) {
          await tx.execute(sql`DELETE FROM "session" WHERE (sess::jsonb) -> 'user' ->> 'id' = ${userId}`);
        },
        async writeAudit(entry: IdentityAuditEntry) {
          await tx.insert(systemLogs).values({
            userId: entry.userId,
            userName: entry.userName,
            userRole: entry.userRole,
            regionId: null,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            entityName: entry.entityName,
            description: entry.description,
            severity: entry.severity,
            success: entry.success,
          });
        },
      };
      return work(context);
    });
  }
}

describe("I2A: refresh/deactivation real-PostgreSQL concurrency and transaction atomicity", () => {
  let authService: AuthService;
  let userManagementUseCase: UserManagementUseCase;
  let actor: StatusTransitionActor;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    await resetTables();
  });

  beforeEach(async () => {
    const userRepo = new DrizzleUserRepository();
    const refreshRepo = new DrizzleRefreshTokenRepository();
    const uow = new DrizzleIdentityUnitOfWork();
    authService = new AuthService(userRepo, refreshRepo, uow);
    userManagementUseCase = new UserManagementUseCase(userRepo, uow);

    const admin = await makeActiveUser("admin");
    actor = { id: admin.id, username: admin.username, role: "admin" };
  });

  afterEach(async () => {
    await resetTables();
  });

  afterAll(async () => {
    await resetTables();
  });

  describe("refresh vs. deactivation races", () => {
    it(
      "deactivation blocks a concurrent refresh on the same user row (proven via pg_blocking_pids), and the refresh fails once it proceeds",
      async () => {
        const u = await makeActiveUser();
        const loginResult = await authService.login({ username: u.username, password: "ConcurrencyTest!1" });
        const refreshToken = loginResult.refreshToken;

        const pausingUow = new PausingIdentityUnitOfWork();
        const deactivateUseCase = new UserManagementUseCase(new DrizzleUserRepository(), pausingUow);

        const deactivatePromise = deactivateUseCase.deactivateUser(u.id, actor);

        await pausingUow.ready;
        const deactivatePid = pausingUow.getBackendPid();

        const refreshPromise = authService.refresh(refreshToken);

        let refreshPid: number | null = null;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && refreshPid === null) {
          const result = await pool.query(
            `select pid from pg_stat_activity where pid != $1 and pid != pg_backend_pid() and state = 'active' and wait_event_type = 'Lock'`,
            [deactivatePid]
          );
          if (result.rows[0]) refreshPid = result.rows[0].pid;
          else await new Promise((r) => setTimeout(r, 50));
        }
        expect(refreshPid).not.toBeNull();
        await waitUntilBlockedBy(refreshPid!, deactivatePid);

        pausingUow.release();
        await deactivatePromise;

        await expect(refreshPromise).rejects.toThrow();
      },
      20000
    );

    it(
      "two concurrent refresh calls with the SAME token: only one rotates successfully (no double rotation)",
      async () => {
        const u = await makeActiveUser();
        const loginResult = await authService.login({ username: u.username, password: "ConcurrencyTest!1" });
        const refreshToken = loginResult.refreshToken;

        const [r1, r2] = await Promise.allSettled([authService.refresh(refreshToken), authService.refresh(refreshToken)]);

        const fulfilled = [r1, r2].filter((o) => o.status === "fulfilled");
        const rejected = [r1, r2].filter((o) => o.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const liveRows = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, u.id));
        expect(liveRows.filter((r) => !r.isRevoked)).toHaveLength(1);
      },
      15000
    );

    it(
      "refresh-wins-then-deactivate: a token rotated just before deactivation is still invalidated by it",
      async () => {
        const u = await makeActiveUser();
        const loginResult = await authService.login({ username: u.username, password: "ConcurrencyTest!1" });
        const refreshResult = await authService.refresh(loginResult.refreshToken);

        await userManagementUseCase.deactivateUser(u.id, actor);

        await expect(authService.refresh(refreshResult.refreshToken)).rejects.toThrow();
      },
      15000
    );
  });

  describe("paused-login race", () => {
    it(
      "a login paused before its refresh-token INSERT, spanning a real deactivate+reactivate, still emits only generation-G credentials that are permanently rejected",
      async () => {
        const u = await makeActiveUser();
        const realRefreshRepo = new DrizzleRefreshTokenRepository();
        const pausing = wrapRefreshRepositoryPausingOnCreate(realRefreshRepo);
        const pausedAuthService = new AuthService(new DrizzleUserRepository(), pausing.wrapped, new DrizzleIdentityUnitOfWork());

        const loginPromise = pausedAuthService.login({ username: u.username, password: "ConcurrencyTest!1" });

        await pausing.ready; // password verified, JWT already signed at generation G — paused before the refresh-token INSERT

        await userManagementUseCase.deactivateUser(u.id, actor); // commits generation G+1
        await userManagementUseCase.reactivateUser(u.id, actor); // isActive=true, generation stays G+1

        pausing.release();
        const loginResult = await loginPromise;

        const jwtUtil = await import("../../../../utils/jwt");
        const { JWT_SECRET } = await import("../../../../core/config/jwt.config");
        const decoded = jwtUtil.verify(loginResult.token, JWT_SECRET);
        expect(decoded.authGeneration).toBe(0);

        const [persistedRow] = await db.select().from(refreshTokens).where(eq(refreshTokens.token, loginResult.refreshToken));
        expect(persistedRow.authGeneration).toBe(0);

        await expect(authService.refresh(loginResult.refreshToken)).rejects.toThrow();

        const freshLogin = await authService.login({ username: u.username, password: "ConcurrencyTest!1" });
        const freshDecoded = jwtUtil.verify(freshLogin.token, JWT_SECRET);
        expect(freshDecoded.authGeneration).toBe(1);
      },
      15000
    );
  });

  describe("mixed PATCH real-transaction rollback", () => {
    it(
      "an ordinary field write that genuinely executes inside the transaction is rolled back together with a subsequently-failing status transition",
      async () => {
        const u = await makeActiveUser();
        const [before] = await db.select().from(users).where(eq(users.id, u.id));

        const faultyUseCase = new UserManagementUseCase(new DrizzleUserRepository(), new FaultAfterOrdinaryUpdateIdentityUnitOfWork());

        await expect(
          faultyUseCase.update(u.id, { fullName: "Rolled Back Name", isActive: false }, actor)
        ).rejects.toThrow("controlled test failure after ordinary field write");

        const [after] = await db.select().from(users).where(eq(users.id, u.id));
        expect(after.fullName).toBe(before.fullName);
        expect(after.isActive).toBe(true);
        expect(after.authGeneration).toBe(before.authGeneration);
      },
      15000
    );
  });

  describe("bulk transitions", () => {
    it(
      "a fault on the second user's status write inside a bulk deactivation rolls back BOTH users' changes",
      async () => {
        const a = await makeActiveUser();
        const b = await makeActiveUser();

        const faultyUseCase = new UserManagementUseCase(new DrizzleUserRepository(), new FaultOnNthUpdateIdentityUnitOfWork(2));

        await expect(faultyUseCase.bulkDeactivate(undefined, actor)).rejects.toThrow();

        const [aAfter] = await db.select().from(users).where(eq(users.id, a.id));
        const [bAfter] = await db.select().from(users).where(eq(users.id, b.id));
        expect(aAfter.isActive).toBe(true);
        expect(aAfter.authGeneration).toBe(0);
        expect(bAfter.isActive).toBe(true);
        expect(bAfter.authGeneration).toBe(0);

        const auditRows = await db.select().from(systemLogs).where(eq(systemLogs.entityType, "user"));
        expect(auditRows).toHaveLength(0);
      },
      15000
    );

    it(
      "bulk deactivation of [A,B] blocks a concurrent single deactivation on B (proven via pg_blocking_pids); B's generation increments exactly once, not twice",
      async () => {
        const a = await makeActiveUser();
        const b = await makeActiveUser();

        const pausingUow = new PausingIdentityUnitOfWork(b.id);
        const bulkUseCase = new UserManagementUseCase(new DrizzleUserRepository(), pausingUow);

        const bulkPromise = bulkUseCase.bulkDeactivate(actor.id, actor);

        await pausingUow.ready; // T1 has locked B specifically and is paused holding that lock
        const t1Pid = pausingUow.getBackendPid();

        const singlePromise = userManagementUseCase.deactivateUser(b.id, actor);

        let t2Pid: number | null = null;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && t2Pid === null) {
          const result = await pool.query(
            `select pid from pg_stat_activity where pid != $1 and pid != pg_backend_pid() and state = 'active' and wait_event_type = 'Lock'`,
            [t1Pid]
          );
          if (result.rows[0]) t2Pid = result.rows[0].pid;
          else await new Promise((r) => setTimeout(r, 50));
        }
        expect(t2Pid).not.toBeNull();
        await waitUntilBlockedBy(t2Pid!, t1Pid);

        pausingUow.release();
        await bulkPromise;
        await singlePromise;

        const [bFinal] = await db.select().from(users).where(eq(users.id, b.id));
        expect(bFinal.authGeneration).toBe(1);
        expect(bFinal.isActive).toBe(false);
      },
      20000
    );
  });

  describe("audit atomicity", () => {
    it("a successful canonical deactivation writes exactly one system_logs row", async () => {
      const u = await makeActiveUser();
      await userManagementUseCase.deactivateUser(u.id, actor);

      const rows = await db.select().from(systemLogs).where(eq(systemLogs.entityId, u.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("deactivate");
    });

    it(
      "a failure occurring strictly AFTER the real audit INSERT rolls the audit row back along with everything else",
      async () => {
        const u = await makeActiveUser();
        const faultyUseCase = new UserManagementUseCase(new DrizzleUserRepository(), new FaultAfterAuditIdentityUnitOfWork());

        await expect(faultyUseCase.deactivateUser(u.id, actor)).rejects.toThrow("controlled test failure after audit insert");

        const [after] = await db.select().from(users).where(eq(users.id, u.id));
        expect(after.isActive).toBe(true);
        expect(after.authGeneration).toBe(0);

        const rows = await db.select().from(systemLogs).where(eq(systemLogs.entityId, u.id));
        expect(rows).toHaveLength(0);
      },
      15000
    );
  });
});
