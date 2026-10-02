import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { AuthenticationError, AuthorizationError, ValidationError } from "@core/errors/AppError";

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Compare against itself to keep timing relatively stable
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function getOwnerConfirmationPhrase(): string {
  return process.env.PLATFORM_LOCK_CONFIRMATION_PHRASE?.trim() || "LOCK SYSTEM";
}

/**
 * Owner channel auth: PLATFORM_OWNER_KEY header + PLATFORM_OWNER_PASSWORD body/header.
 * Ordinary ADMIN sessions are never accepted here.
 */
export function requirePlatformOwner(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const expectedKey = process.env.PLATFORM_OWNER_KEY?.trim();
    const expectedPassword = process.env.PLATFORM_OWNER_PASSWORD?.trim();

    if (!expectedKey || !expectedPassword) {
      throw new AuthorizationError("قناة مالك المنصة غير مهيأة على هذا السيرفر");
    }

    const providedKey = String(req.header("x-platform-owner-key") || "");
    const providedPassword = String(
      req.header("x-platform-owner-password") ||
        (req.body && typeof req.body.ownerPassword === "string" ? req.body.ownerPassword : "") ||
        "",
    );

    if (!providedKey || !timingSafeEqualString(providedKey, expectedKey)) {
      throw new AuthenticationError("مفتاح مالك المنصة غير صالح");
    }
    if (!providedPassword || !timingSafeEqualString(providedPassword, expectedPassword)) {
      throw new AuthenticationError("كلمة مرور مالك المنصة غير صحيحة");
    }

    // Explicitly reject treating customer admin as owner even if somehow present
    if (req.user?.role === "admin") {
      // Still OK if secrets are valid — secrets are the authority. Do not use admin role.
    }

    (req as any).platformOwner = { actor: "platform-owner" };
    next();
  } catch (error) {
    next(error);
  }
}

export function assertConfirmationPhrase(provided: unknown): void {
  const expected = getOwnerConfirmationPhrase();
  if (typeof provided !== "string" || !timingSafeEqualString(provided.trim(), expected)) {
    throw new ValidationError("عبارة التأكيد غير صحيحة");
  }
}

export function assertCliSecret(provided: string | undefined): void {
  const expected = process.env.PLATFORM_LOCK_CLI_SECRET?.trim();
  if (!expected) {
    throw new Error("PLATFORM_LOCK_CLI_SECRET is not configured");
  }
  if (!provided || !timingSafeEqualString(provided, expected)) {
    throw new Error("Invalid PLATFORM_LOCK_CLI_SECRET");
  }
}
