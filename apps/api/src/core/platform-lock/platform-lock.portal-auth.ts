import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { AuthenticationError, AuthorizationError } from "@core/errors/AppError";

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function portalSigningSecret(): string {
  return (
    process.env.PLATFORM_OWNER_KEY?.trim() ||
    process.env.PLATFORM_LOCK_CLI_SECRET?.trim() ||
    ""
  );
}

export function verifyOwnerPassword(password: string): boolean {
  const expected = process.env.PLATFORM_OWNER_PASSWORD?.trim();
  if (!expected || !password) return false;
  return timingSafeEqualString(password, expected);
}

export function issueOwnerPortalToken(ttlMs = 2 * 60 * 60 * 1000): string {
  const secret = portalSigningSecret();
  if (!secret) throw new AuthorizationError("قناة مالك المنصة غير مهيأة");
  const payload = Buffer.from(
    JSON.stringify({ role: "platform_owner", exp: Date.now() + ttlMs }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyOwnerPortalToken(token: string): boolean {
  const secret = portalSigningSecret();
  if (!secret || !token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!timingSafeEqualString(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      role?: string;
      exp?: number;
    };
    if (data.role !== "platform_owner") return false;
    if (typeof data.exp !== "number" || Date.now() > data.exp) return false;
    return true;
  } catch {
    return false;
  }
}

/** Password-only portal session (Bearer owner-portal token). */
export function requireOwnerPortalSession(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    if (!process.env.PLATFORM_OWNER_PASSWORD?.trim() || !portalSigningSecret()) {
      throw new AuthorizationError("قناة مالك المنصة غير مهيأة على هذا السيرفر");
    }
    const auth = String(req.header("authorization") || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token || !verifyOwnerPortalToken(token)) {
      throw new AuthenticationError("جلسة المالك غير صالحة أو منتهية");
    }
    (req as any).platformOwner = { actor: "owner-portal" };
    next();
  } catch (error) {
    next(error);
  }
}
