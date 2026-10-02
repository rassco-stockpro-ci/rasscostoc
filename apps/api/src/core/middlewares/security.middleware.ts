import type { Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "../config/db";
import { logger } from "../telemetry/logger";
import * as jwt from "@server/utils/jwt";
import { JWT_SECRET } from "../config/jwt.config";

const LIMIT_WINDOW_MS = 60000; // 1 minute window
// ROOT FIX: raised from 150 — this budget used to be shared per-IP (see
// rateLimitKey below for why that was the real problem), so 150/min had to
// absorb every technician behind one office/carrier NAT combined. Per-key
// is now per-authenticated-user, so each technician gets their own budget;
// 300 gives real headroom for a busy closing session (each courier close
// fires several serial-lookup calls per scan attempt) without meaningfully
// weakening abuse protection on unauthenticated endpoints (still IP-keyed).
const MAX_REQUESTS_PER_WINDOW = 300;

/**
 * ERP-008 Phase 4: the counter used to live in a process-local `Map`, so
 * under multi-process/PM2-cluster operation each process enforced its own
 * independent limit -- a client could bypass the aggregate limit just by
 * landing on a different process. This single statement is the only place
 * the count changes: INSERT ... ON CONFLICT DO UPDATE is atomic in
 * Postgres, so concurrent callers (same process or different processes)
 * serialize on the row and never lose an increment. The CASE expressions
 * roll the window over (reset to 1) when the previous reset_at has passed,
 * matching the prior in-memory "expired record" behavior.
 */
async function incrementRateLimitCounter(
  key: string,
  windowMs: number
): Promise<{ count: number; resetAt: number }> {
  const newResetAt = new Date(Date.now() + windowMs);
  const result = await db.execute(sql`
    INSERT INTO rate_limit_counters (key, count, reset_at)
    VALUES (${key}, 1, ${newResetAt})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limit_counters.reset_at <= now() THEN 1 ELSE rate_limit_counters.count + 1 END,
      reset_at = CASE WHEN rate_limit_counters.reset_at <= now() THEN ${newResetAt} ELSE rate_limit_counters.reset_at END
    RETURNING count, reset_at
  `);
  const row = result.rows[0] as { count: number; reset_at: string };
  return { count: Number(row.count), resetAt: new Date(row.reset_at).getTime() };
}

/**
 * Custom Rate Limiting middleware to prevent brute-force attacks and abuse.
 */
export async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Bypass rate limiting in development mode
  if (process.env.NODE_ENV !== "production") {
    return next();
  }

  // Bypass rate limiting for health check endpoints
  const path = req.path;
  if (
    path === "/health" || path === "/health/live" || path === "/health/ready" ||
    path === "/api/health" || path === "/api/health/live" || path === "/api/health/ready"
  ) {
    return next();
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown-ip";

  // ROOT FIX: this ran BEFORE session/auth resolution in the middleware
  // chain, so it had no choice but to key on raw IP — meaning every
  // technician behind the same office/mobile-carrier NAT shared ONE 150
  // req/min budget. Confirmed in production logs: repeated "Rate limit
  // exceeded" bursts for a single IP, which throttles an unrelated
  // technician's legitimate close-order attempt just because someone else
  // on the same network used up the shared quota. Decoding the Bearer
  // token here (the same JWT requireAuth verifies later) lets each signed-in
  // technician get their own independent budget; requests with no valid
  // token (login, public verification lookups, etc.) still key on IP, so
  // brute-force protection on those endpoints is unchanged.
  const rateLimitKey = ((): string => {
    // Defensive: req.headers is always a real object on genuine Express
    // requests, but minimal request-like mocks (e.g. this middleware's own
    // race/concurrency test harness) may omit it entirely — optional
    // chaining here keeps that a clean IP-keyed fallback instead of an
    // uncaught TypeError that the caller's own catch() then silently turns
    // into a misleading 500 for every request.
    const authHeader = req.headers?.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return `ip:${ip}`;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded?.userId) return `user:${decoded.userId}`;
    } catch {
      // Invalid/expired token — requireAuth (if this route needs it) will
      // reject it properly later; here we just fall back to IP keying.
    }
    return `ip:${ip}`;
  })();

  let count: number;
  let resetAt: number;
  try {
    ({ count, resetAt } = await incrementRateLimitCounter(rateLimitKey, LIMIT_WINDOW_MS));
  } catch (err) {
    // Fail-open: every other component on this request path (sessions,
    // readiness) already hard-depends on the same database, so a DB outage
    // already degrades the API elsewhere. Rate limiting is a defense against
    // abuse under normal operation, not a resource the API must remain
    // available without -- refusing all traffic here would turn a rate-limit
    // storage hiccup into a full outage, which is a worse outcome.
    logger.error({
      message: "Rate limiter storage error - failing open",
      module: "security",
      action: "rateLimiterStorageError",
      metadata: { ip, path, error: (err as Error).message },
    });
    return next();
  }

  const remaining = Math.max(0, MAX_REQUESTS_PER_WINDOW - count);
  res.setHeader("X-RateLimit-Limit", MAX_REQUESTS_PER_WINDOW);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", Math.ceil(resetAt / 1000));

  if (count > MAX_REQUESTS_PER_WINDOW) {
    logger.warn({
      message: `Rate limit exceeded for key: ${rateLimitKey}`,
      module: "security",
      action: "rateLimitExceeded",
      metadata: { ip, rateLimitKey, path, count }
    });

    res.status(429).json({
      error: "Too Many Requests",
      message: "لقد تجاوزت الحد المسموح به من الطلبات. يرجى المحاولة مرة أخرى لاحقاً.",
    });
    return;
  }

  next();
}

/**
 * Helmet-equivalent Security Headers middleware.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Prevent clickjacking
  res.setHeader("X-Frame-Options", "DENY");

  // XSS protection
  res.setHeader("X-XSS-Protection", "1; mode=block");

  // Referrer Policy
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");

  // HSTS (HTTP Strict Transport Security) - active in production
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  // Basic Content Security Policy (CSP)
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      // Image sources (allow self, data, blob, openstreetmap, cartocdn, google, and external https images)
      "img-src 'self' data: blob: https:",
      "connect-src 'self'",
      // Zero Local Storage: courier PDF reports embed the original document straight from
      // Google Drive's own /preview iframe endpoint (never proxied/downloaded through RASSCO).
      // Without this, default-src 'self' silently blocks that iframe and Chrome shows
      // "This content is blocked. Contact the site owner to fix the issue." regardless of
      // whether the Drive URL itself is a valid /preview link.
      "frame-src 'self' https://drive.google.com https://docs.google.com",
    ].join("; ")
  );

  next();
}

/**
 * CSRF protection middleware for cookie-authenticated sessions.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  const mutatingMethods = ["POST", "PUT", "PATCH", "DELETE"];
  
  if (mutatingMethods.includes(req.method)) {
    const authHeader = req.headers.authorization;
    const hasBearer = authHeader && authHeader.startsWith("Bearer ");
    const hasTokenQuery = req.query.token;

    // If request uses Bearer token, CSRF is not possible (immune)
    if (hasBearer || hasTokenQuery) {
      return next();
    }

    // If session-cookie is present and active, enforce custom header presence
    const sessionObj = (req as any).session;
    if (sessionObj && sessionObj.user) {
      const csrfHeader = req.headers["x-requested-with"] || req.headers["x-csrf-token"];
      if (!csrfHeader) {
        res.status(403).json({
          error: "Forbidden",
          message: "طلب غير صالح (حماية CSRF). يرجى تضمين ترويسة X-Requested-With أو X-CSRF-Token.",
        });
        return;
      }
    }
  }
  next();
}
