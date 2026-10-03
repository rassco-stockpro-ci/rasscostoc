/**
 * Authentication and authorization middleware
 */

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { AuthenticationError, AuthorizationError } from "@core/errors/AppError";
import { ROLES, hasRoleOrAbove } from "@shared/roles";
import * as jwt from "@server/utils/jwt";
import { JWT_SECRET } from "@core/config/jwt.config";
import { getDatabase } from "@core/database/connection";
import { users } from "@shared/schema";
import { eq, or } from "drizzle-orm";

// Extend Express Request type to include full user context
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: string;
        username: string;
        regionId: string | null;
        employeeCode: string | null;
        technicianCode: string | null;
        permissions: string[];
      };
    }
  }
}

// Session store interface
interface SessionStore {
  get(token: string): Promise<SessionData | null>;
  set(token: string, data: SessionData, expiry: number): Promise<void>;
  delete(token: string): Promise<void>;
}

export interface SessionData {
  userId: string;
  role: string;
  username: string;
  regionId: string | null;
  expiry: number;
}

// PostgreSQL-backed session store for Bearer tokens
import { pool } from "@core/config/db";

type AuthUser = {
  id: string;
  role: string;
  username: string;
  regionId: string | null;
  employeeCode: string | null;
  technicianCode: string | null;
  permissions: string[];
};

/**
 * Outcome of resolving a credential's claimed user identity against the
 * authoritative current database state. NOT_FOUND and LOOKUP_FAILURE are kept
 * distinct on purpose — a database error must never be treated as "no such
 * user" and must never fall back to trusting the credential's own claims.
 * Every requireAuth branch below must reject on every variant except
 * FOUND_ACTIVE.
 */
type AuthResolution =
  | { kind: "FOUND_ACTIVE"; user: AuthUser; authGeneration: number }
  | { kind: "FOUND_INACTIVE" }
  | { kind: "NOT_FOUND" }
  | { kind: "LOOKUP_FAILURE"; error: unknown };

/**
 * Thrown when the authoritative user lookup itself fails (a database/
 * infrastructure error), never when it merely finds no active match. Callers
 * must let this propagate to the global error handler as a genuine server
 * error — never wrap it as an AuthenticationError, and never treat a request
 * that hit this path as authenticated.
 */
class AuthInfrastructureError extends Error {
  constructor(cause: unknown) {
    super("Authentication service temporarily unavailable");
    this.name = "AuthInfrastructureError";
    this.cause = cause as Error | undefined;
  }
}

/**
 * Resolves a user id to its authoritative current state: existence,
 * active-state, and credential generation, plus the identity fields used to
 * populate req.user. Never merges its result with data taken from the
 * presented credential — callers must treat this as the single source of
 * truth for every request.
 */
async function resolveAuthState(userId: string): Promise<AuthResolution> {
  try {
    const db = getDatabase();
    const [row] = await db
      .select({
        id: users.id,
        role: users.role,
        username: users.username,
        regionId: users.regionId,
        employeeCode: users.employeeCode,
        technicianCode: users.technicianCode,
        permissions: users.permissions,
        isActive: users.isActive,
        authGeneration: users.authGeneration,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row) return { kind: "NOT_FOUND" };
    if (!row.isActive) return { kind: "FOUND_INACTIVE" };

    return {
      kind: "FOUND_ACTIVE",
      authGeneration: row.authGeneration,
      user: {
        id: row.id,
        role: row.role,
        username: row.username,
        regionId: row.regionId ?? null,
        employeeCode: row.employeeCode ?? null,
        technicianCode: row.technicianCode ?? null,
        permissions: row.permissions ? JSON.parse(row.permissions) : [],
      },
    };
  } catch (error) {
    console.error("Auth user refresh error:", error);
    return { kind: "LOOKUP_FAILURE", error };
  }
}

class PostgresSessionStore implements SessionStore {
  async get(token: string): Promise<SessionData | null> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT user_id AS "userId", role, username, region_id AS "regionId", expiry FROM bearer_sessions WHERE token = $1`,
        [token]
      );

      if (result.rows && result.rows.length > 0) {
        const row = result.rows[0];
        const now = Date.now();

        // Check if session has expired
        if (Number(row.expiry) < now) {
          await this.delete(token);
          return null;
        }

        return {
          userId: row.userId,
          role: row.role,
          username: row.username,
          regionId: row.regionId,
          expiry: Number(row.expiry)
        };
      }
      return null;
    } catch (error) {
      console.error("Session get error:", error);
      return null;
    } finally {
      client.release();
    }
  }

  async set(token: string, data: SessionData, expiry: number): Promise<void> {
    const client = await pool.connect();
    try {
      // Table is managed by Drizzle schema (bearer_sessions in auth.schema.ts)
      await client.query(
        `INSERT INTO bearer_sessions (token, user_id, role, username, region_id, expiry)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (token) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           role = EXCLUDED.role,
           username = EXCLUDED.username,
           region_id = EXCLUDED.region_id,
           expiry = EXCLUDED.expiry`,
        [token, data.userId, data.role, data.username, data.regionId, expiry]
      );
    } catch (error) {
      console.error("Session set error:", error);
    } finally {
      client.release();
    }
  }

  async delete(token: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(`DELETE FROM bearer_sessions WHERE token = $1`, [token]);
    } catch (error) {
      console.error("Session delete error:", error);
    } finally {
      client.release();
    }
  }
}

// Export PostgreSQL-backed session store instance
export const sessionStore: SessionStore = new PostgresSessionStore();

/**
 * Middleware to require authentication
 * Checks Bearer token first (Frontend primary method), then Express Session
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 1. Check Bearer token FIRST (Frontend sends this or query param)
    const authHeader = req.headers.authorization;
    let token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
    if (!token && req.query.token) {
      token = String(req.query.token);
    }

    if (token) {
      try {
        // Attempt JWT verification first
        const decoded = jwt.verify(token, JWT_SECRET);

        // Missing claim (pre-migration token) is interpreted as generation 0.
        const claimedGeneration = typeof decoded.authGeneration === "number" ? decoded.authGeneration : 0;
        const resolution = await resolveAuthState(decoded.userId);

        if (resolution.kind === "LOOKUP_FAILURE") {
          // The lookup itself failed — this is an infrastructure fault, not an
          // authentication decision. Fail closed via the generic server-error
          // path, never as a credential-invalid 401, and never installing the
          // token's own stale claims into req.user.
          throw new AuthInfrastructureError(resolution.error);
        }
        if (resolution.kind !== "FOUND_ACTIVE") {
          // NOT_FOUND and FOUND_INACTIVE fail closed with the same
          // externally-visible message — no enumeration of why.
          throw new AuthenticationError("Session expired");
        }
        if (resolution.authGeneration !== claimedGeneration) {
          // The account was deactivated (and possibly reactivated) since this
          // token was signed — its lineage is permanently invalid.
          throw new AuthenticationError("Session expired");
        }

        req.user = resolution.user;
        return next();
      } catch (jwtError) {
        // A genuine JWT verification failure (bad signature, malformed,
        // expired) falls through to the legacy bearer-session lookup below.
        // An AuthenticationError or AuthInfrastructureError thrown by the
        // block above (inactive/missing/generation-mismatched, or a lookup
        // failure) must NOT fall through to that fallback — it is already a
        // final, authoritative rejection.
        if (jwtError instanceof AuthenticationError || jwtError instanceof AuthInfrastructureError) {
          throw jwtError;
        }

        const session = await sessionStore.get(token);
        if (session) {
          const resolution = await resolveAuthState(session.userId);
          if (resolution.kind === "LOOKUP_FAILURE") {
            throw new AuthInfrastructureError(resolution.error);
          }
          if (resolution.kind !== "FOUND_ACTIVE") {
            throw new AuthenticationError("Session expired");
          }

          req.user = resolution.user;

          if (
            resolution.user.role !== session.role ||
            resolution.user.username !== session.username ||
            resolution.user.regionId !== session.regionId
          ) {
            await sessionStore.set(
              token,
              {
                userId: resolution.user.id,
                role: resolution.user.role,
                username: resolution.user.username,
                regionId: resolution.user.regionId,
                expiry: session.expiry,
              },
              session.expiry
            );
          }

          return next();
        }

        throw new AuthenticationError("Session expired");
      }
    }

    // 2. Fallback to Express Session (PostgreSQL-backed cookie)
    const sessionObj = (req as any).session;
    if (sessionObj && sessionObj.user) {
      const sessionUser = sessionObj.user as AuthUser & { authGeneration?: number };
      if (!sessionUser?.id) {
        throw new AuthenticationError("Session expired");
      }

      const claimedGeneration = typeof sessionUser.authGeneration === "number" ? sessionUser.authGeneration : 0;
      const resolution = await resolveAuthState(sessionUser.id);

      if (resolution.kind === "LOOKUP_FAILURE") {
        throw new AuthInfrastructureError(resolution.error);
      }
      if (resolution.kind !== "FOUND_ACTIVE") {
        throw new AuthenticationError("Session expired");
      }
      if (resolution.authGeneration !== claimedGeneration) {
        throw new AuthenticationError("Session expired");
      }

      req.user = resolution.user;
      sessionObj.user = { ...resolution.user, authGeneration: resolution.authGeneration };

      return next();
    }

    throw new AuthenticationError("Session expired");
  } catch (error) {
    next(error);
  }
}

/**
 * Middleware to require admin role (System Manager only)
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    return next(new AuthenticationError("Authentication required"));
  }

  if (req.user.role !== ROLES.ADMIN) {
    return next(new AuthorizationError("يجب أن تكون مدير نظام للوصول إلى هذه الصفحة"));
  }

  next();
}

/**
 * Internal service key ONLY (X-Internal-Service-Key) — no user session, no Telegram identity.
 * For endpoints the installation bot calls before the Telegram account is linked to anyone
 * (e.g. POST /api/telegram/link). Constant-time comparison.
 */
export function requireInternalService(req: Request, _res: Response, next: NextFunction): void {
  const expected = process.env.INTERNAL_SERVICE_KEY || process.env.SYSTEM_INTERNAL_TOKEN;
  const provided = req.header("x-internal-service-key");
  const digest = (v: string) => crypto.createHash("sha256").update(v).digest();
  if (expected && provided && crypto.timingSafeEqual(digest(expected), digest(provided))) {
    return next();
  }
  next(new AuthenticationError("Internal service key required"));
}

/**
 * PLATFORM-P0 — Admin session OR internal service key (X-Internal-Service-Key).
 */
export async function requireAdminOrInternal(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const expected = process.env.INTERNAL_SERVICE_KEY || process.env.SYSTEM_INTERNAL_TOKEN;
    const provided = req.header("x-internal-service-key");
    if (expected && provided && provided === expected) {
      return next();
    }

    await new Promise<void>((resolve, reject) => {
      void requireAuth(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
    });

    if (!req.user) {
      throw new AuthenticationError("Authentication required");
    }
    if (req.user.role !== ROLES.ADMIN) {
      throw new AuthorizationError("يجب أن تكون مدير نظام أو خدمة داخلية للوصول");
    }
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Telegram installation bot integration (courier/pdf) — an internal service
 * (no human session) authenticates with INTERNAL_SERVICE_KEY, but unlike
 * requireAdminOrInternal it must act AS the real field technician submitting
 * the report (so uploadedBy/technicianCode/region resolve correctly), not as
 * an admin or a single generic bot account. The technician is resolved via
 * their linked telegram_user_id (see 0025_erp_users_telegram_user_id.sql).
 * Falls back to normal requireAuth when no internal key is presented, so the
 * human web upload/review UI is completely unaffected.
 */
export async function requireAuthOrInternal(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const expected = process.env.INTERNAL_SERVICE_KEY || process.env.SYSTEM_INTERNAL_TOKEN;
    const provided = req.header("x-internal-service-key");

    if (expected && provided && provided === expected) {
      const telegramUserId = req.header("x-telegram-user-id");
      if (!telegramUserId) {
        throw new AuthenticationError(
          "x-telegram-user-id header required alongside x-internal-service-key"
        );
      }

      const cleanTgId = telegramUserId.replace(/^@/, "");
      const db = getDatabase();
      const [row] = await db
        .select({
          id: users.id,
          role: users.role,
          username: users.username,
          regionId: users.regionId,
          employeeCode: users.employeeCode,
          technicianCode: users.technicianCode,
          permissions: users.permissions,
          isActive: users.isActive,
        })
        .from(users)
        .where(
          or(
            eq(users.telegramUserId, telegramUserId),
            eq(users.telegramUserId, cleanTgId),
            eq(users.telegramUserId, `@${cleanTgId}`)
          )
        )
        .limit(1);

      if (!row || !row.isActive) {
        throw new AuthenticationError(
          "No active technician linked to this Telegram account"
        );
      }

      req.user = {
        id: row.id,
        role: row.role,
        username: row.username,
        regionId: row.regionId ?? null,
        employeeCode: row.employeeCode ?? null,
        technicianCode: row.technicianCode ?? null,
        permissions: row.permissions ? JSON.parse(row.permissions) : [],
      };
      return next();
    }

    return requireAuth(req, res, next);
  } catch (error) {
    next(error);
  }
}

/**
 * Middleware to require supervisor role or above
 */
export function requireSupervisor(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    return next(new AuthenticationError("Authentication required"));
  }

  if (!hasRoleOrAbove(req.user.role, ROLES.SUPERVISOR)) {
    return next(new AuthorizationError("يجب أن تكون مشرف أو أعلى للوصول إلى هذه الصفحة"));
  }

  next();
}

/**
 * Middleware to require supervisor role only (exclude admin)
 */
export function requireSupervisorOnly(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    return next(new AuthenticationError("Authentication required"));
  }

  if (req.user.role !== ROLES.SUPERVISOR) {
    return next(new AuthorizationError("هذه العملية متاحة للمشرف فقط"));
  }

  next();
}

/**
 * Middleware factory to require a specific role or above
 */
export function requireRole(minRole: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AuthenticationError("Authentication required"));
    }

    if (!hasRoleOrAbove(req.user.role, minRole)) {
      return next(new AuthorizationError("ليس لديك الصلاحيات الكافية"));
    }

    next();
  };
}

/**
 * Generate a session token
 */
export function generateSessionToken(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}
