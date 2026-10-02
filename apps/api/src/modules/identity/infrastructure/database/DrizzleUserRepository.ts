import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { IUserRepository, OrdinaryUserFieldUpdate, UserAuthState, UserSecurityState } from '@stockpro/contracts';
import { getDatabase } from "@core/database/connection";
import { type InsertUser, type User, type UserSafe, users } from "@shared/schema";
import * as schema from "@shared/schema";

/**
 * The real, exported Drizzle transaction type for this schema — not a
 * placeholder and not `any`. Lets a repository instance be bound either to
 * the global connection or to an open transaction's `tx` handle with no cast
 * at any call site (see DrizzleIdentityUnitOfWork.ts).
 */
export type IdentityDbTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
export type IdentityDbClient = NodePgDatabase<typeof schema> | IdentityDbTransaction;

/**
 * The only fields an ordinary field update may ever persist. Enforced as an
 * explicit allowlist copy (never a blind object spread) so that `isActive`/
 * `authGeneration`/`role` cannot reach the generated UPDATE statement even
 * from a runtime caller that bypassed TypeScript entirely — the type system
 * alone is not treated as the security boundary here.
 *
 * OPS-PERM-S1-F4-R2: `role` was removed from this list. Like isActive, a role
 * change can remove the system's last active Admin — it now persists only
 * through updateUserRole(), reachable solely via IdentityTransactionalContext
 * inside the canonical admin-membership transition (UserManagement.use-case.ts).
 */
const ORDINARY_FIELD_KEYS = [
  "username",
  "email",
  "password",
  "fullName",
  "profileImage",
  "city",
  "regionId",
  "employeeCode",
  "technicianCode",
  "department",
  "permissions",
  "fcmToken",
  "telegramUserId",
] as const satisfies readonly (keyof OrdinaryUserFieldUpdate)[];

export class DrizzleUserRepository implements IUserRepository {
  /**
   * Pass a transaction handle (the `tx` from db.transaction(async (tx) => ...))
   * to bind this repository instance to that transaction — required whenever
   * its writes must be atomic with writes made through another repository
   * (see DrizzleIdentityUnitOfWork). Omit to use the global connection.
   */
  constructor(private readonly dbClient: IdentityDbClient = getDatabase()) {}

  private get db(): IdentityDbClient {
    return this.dbClient;
  }

  async getUsers(): Promise<UserSafe[]> {
    return this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        fullName: users.fullName,
        profileImage: users.profileImage,
        city: users.city,
        role: users.role,
        regionId: users.regionId,
        employeeCode: users.employeeCode,
        technicianCode: users.technicianCode,
        department: users.department,
        permissions: users.permissions,
        isActive: users.isActive,
        authGeneration: users.authGeneration,
        fcmToken: users.fcmToken,
        telegramUserId: users.telegramUserId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users);
  }

  async getUser(id: string): Promise<UserSafe | undefined> {
    const [user] = await this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        fullName: users.fullName,
        profileImage: users.profileImage,
        city: users.city,
        role: users.role,
        regionId: users.regionId,
        employeeCode: users.employeeCode,
        technicianCode: users.technicianCode,
        department: users.department,
        permissions: users.permissions,
        isActive: users.isActive,
        authGeneration: users.authGeneration,
        fcmToken: users.fcmToken,
        telegramUserId: users.telegramUserId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, id));

    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    // Production parity (03f7a1a): usernames match case- and
    // surrounding-whitespace-insensitively, as Production does today.
    if (!username || !username.trim()) return undefined;
    const cleanUsername = username.trim();
    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`LOWER(TRIM(${users.username})) = LOWER(${cleanUsername})`);

    return user || undefined;
  }

  async getUsersByRole(role: string): Promise<UserSafe[]> {
    return this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        fullName: users.fullName,
        profileImage: users.profileImage,
        city: users.city,
        role: users.role,
        regionId: users.regionId,
        employeeCode: users.employeeCode,
        technicianCode: users.technicianCode,
        department: users.department,
        permissions: users.permissions,
        isActive: users.isActive,
        authGeneration: users.authGeneration,
        fcmToken: users.fcmToken,
        telegramUserId: users.telegramUserId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.role, role as any));
  }

  async getUsersByRegion(regionId: string): Promise<UserSafe[]> {
    return this.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        fullName: users.fullName,
        profileImage: users.profileImage,
        city: users.city,
        role: users.role,
        regionId: users.regionId,
        employeeCode: users.employeeCode,
        technicianCode: users.technicianCode,
        department: users.department,
        permissions: users.permissions,
        isActive: users.isActive,
        authGeneration: users.authGeneration,
        fcmToken: users.fcmToken,
        telegramUserId: users.telegramUserId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.regionId, regionId));
  }

  async createUser(insertUser: InsertUser): Promise<UserSafe> {
    const existingUserByUsername = await this.getUserByUsername(insertUser.username);
    if (existingUserByUsername) {
      throw new Error('Username already exists');
    }

    const [existingUserByEmail] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, insertUser.email));
    if (existingUserByEmail) {
      throw new Error('Email already exists');
    }

    const [user] = await this.db
      .insert(users)
      .values({
        ...insertUser,
        role: insertUser.role || 'technician',
        isActive: insertUser.isActive ?? true,
        // Applied last, after the caller-supplied spread, so a genuinely new
        // account can never start at any generation other than 0 — even if a
        // runtime caller bypassed InsertUser's type-level omission of this
        // field entirely.
        authGeneration: 0,
      })
      .returning({
        id: users.id,
        username: users.username,
        email: users.email,
        fullName: users.fullName,
        profileImage: users.profileImage,
        city: users.city,
        role: users.role,
        regionId: users.regionId,
        employeeCode: users.employeeCode,
        technicianCode: users.technicianCode,
        department: users.department,
        permissions: users.permissions,
        isActive: users.isActive,
        authGeneration: users.authGeneration,
        fcmToken: users.fcmToken,
        telegramUserId: users.telegramUserId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      });

    return user;
  }

  async updateUser(id: string, updates: OrdinaryUserFieldUpdate): Promise<UserSafe> {
    const existingUser = await this.getUser(id);
    if (!existingUser) {
      throw new Error(`User with id ${id} not found`);
    }

    if (updates.username && updates.username !== existingUser.username) {
      const existingUserByUsername = await this.getUserByUsername(updates.username);
      if (existingUserByUsername) {
        throw new Error('Username already exists');
      }
    }

    if (updates.email && updates.email !== existingUser.email) {
      const [existingUserByEmail] = await this.db
        .select()
        .from(users)
        .where(eq(users.email, updates.email));
      if (existingUserByEmail) {
        throw new Error('Email already exists');
      }
    }

    // Explicit allowlist copy — never a blind `...updates` spread — so
    // `isActive`/`authGeneration` cannot reach this UPDATE statement even
    // from a runtime object shaped outside what TypeScript would allow here.
    const safeUpdates: Record<string, unknown> = {};
    for (const key of ORDINARY_FIELD_KEYS) {
      if (key in updates) {
        safeUpdates[key] = (updates as Record<string, unknown>)[key];
      }
    }

    const [user] = await this.db
      .update(users)
      .set({
        ...safeUpdates,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        username: users.username,
        email: users.email,
        fullName: users.fullName,
        profileImage: users.profileImage,
        city: users.city,
        role: users.role,
        regionId: users.regionId,
        employeeCode: users.employeeCode,
        technicianCode: users.technicianCode,
        department: users.department,
        permissions: users.permissions,
        isActive: users.isActive,
        authGeneration: users.authGeneration,
        fcmToken: users.fcmToken,
        telegramUserId: users.telegramUserId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      });

    return user;
  }

  /**
   * Locks the user row (SELECT ... FOR UPDATE) and returns its current
   * isActive/authGeneration/role state — role is read atomically under the
   * SAME lock (OPS-PERM-S1-F4-R2), not via a second, separately-timed query.
   * Not part of IUserRepository — reachable only through
   * IdentityTransactionalContext (see
   * DrizzleIdentityUnitOfWork.buildIdentityTransactionalContext), so a bare
   * IUserRepository holder can never perform this transaction-scoped,
   * security-state-relevant read.
   */
  async lockUserForUpdate(id: string): Promise<UserSecurityState | undefined> {
    const [row] = await this.db
      .select({ isActive: users.isActive, authGeneration: users.authGeneration, role: users.role })
      .from(users)
      .where(eq(users.id, id))
      .for("update");

    return row ?? undefined;
  }

  /**
   * Persistence primitive for a status transition: sets isActive and
   * authGeneration in one statement. Not part of IUserRepository — same
   * containment reasoning as lockUserForUpdate above.
   */
  async updateUserState(id: string, state: UserAuthState): Promise<void> {
    await this.db
      .update(users)
      .set({
        isActive: state.isActive,
        authGeneration: state.authGeneration,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
  }

  /**
   * OPS-PERM-S1-F4-R2 — persistence primitive for a role transition: sets
   * `role` in one statement. Not part of IUserRepository — same containment
   * reasoning as updateUserState above. The only place `role` can be
   * persisted at all, now that it is absent from ORDINARY_FIELD_KEYS.
   */
  async updateUserRole(id: string, role: string): Promise<void> {
    await this.db
      .update(users)
      .set({
        role,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
  }
}
