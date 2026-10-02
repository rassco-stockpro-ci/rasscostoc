import type { Express, Request, Response } from "express";
import { asyncHandler } from "@core/errors/errorHandler";
import { AuthenticationError, ValidationError } from "@core/errors/AppError";
import { platformLockService } from "./platform-lock.service";
import { assertConfirmationPhrase, requirePlatformOwner } from "./platform-lock.owner-auth";
import {
  issueOwnerPortalToken,
  requireOwnerPortalSession,
  verifyOwnerPassword,
} from "./platform-lock.portal-auth";
import { platformOpsService } from "./platform-lock.ops.service";
import { isPlatformLockMode, type PlatformLockMode } from "./platform-lock.types";

function clientIp(req: Request): string {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0]?.trim();
  return xf || req.ip || req.socket.remoteAddress || "unknown";
}

function publicStatusPayload() {
  const state = platformLockService.getCachedState();
  return {
    mode: state.mode,
    active: state.mode === "ACTIVE",
    publicMessage: platformLockService.getPublicMessage(state),
    systemLockVersion: state.systemLockVersion,
    subscriptionExpiresAt: state.subscriptionExpiresAt,
    gracePeriodEndsAt: state.gracePeriodEndsAt,
    updatedAt: state.updatedAt,
    source: state.source,
  };
}

export function registerPlatformLockRoutes(app: Express): void {
  // Public-ish status for maintenance page / ops probes (no secrets, no internals).
  app.get(
    "/api/platform-lock/public-status",
    asyncHandler(async (_req: Request, res: Response) => {
      await platformLockService.refresh();
      res.json(publicStatusPayload());
    }),
  );

  app.post(
    "/api/platform-lock/status",
    requirePlatformOwner,
    asyncHandler(async (_req: Request, res: Response) => {
      const state = await platformLockService.refresh();
      res.json({
        ...state,
        confirmationPhraseRequired: true,
      });
    }),
  );

  app.post(
    "/api/platform-lock/enable",
    requirePlatformOwner,
    asyncHandler(async (req: Request, res: Response) => {
      assertConfirmationPhrase(req.body?.confirmationPhrase);
      const mode = req.body?.mode as PlatformLockMode;
      if (!isPlatformLockMode(mode) || mode === "ACTIVE") {
        throw new ValidationError("mode must be MAINTENANCE | SUBSCRIPTION_SUSPENDED | SECURITY_LOCKDOWN");
      }
      if (!req.body?.ownerPassword && !req.header("x-platform-owner-password")) {
        throw new ValidationError("يجب إعادة إدخال كلمة مرور المالك");
      }

      const state = await platformLockService.enable({
        mode,
        publicMessage: typeof req.body?.publicMessage === "string" ? req.body.publicMessage : undefined,
        internalReason: typeof req.body?.internalReason === "string" ? req.body.internalReason : undefined,
        lockedBy: "platform-owner-api",
        stopWorkers: req.body?.stopWorkers !== false,
        revokeSessions: req.body?.revokeSessions !== false,
        suspensionReason:
          typeof req.body?.suspensionReason === "string" ? req.body.suspensionReason : undefined,
      });
      res.json(state);
    }),
  );

  app.post(
    "/api/platform-lock/disable",
    requirePlatformOwner,
    asyncHandler(async (req: Request, res: Response) => {
      assertConfirmationPhrase(req.body?.confirmationPhrase);
      if (!req.body?.ownerPassword && !req.header("x-platform-owner-password")) {
        throw new ValidationError("يجب إعادة إدخال كلمة مرور المالك");
      }
      const state = await platformLockService.disable(
        "platform-owner-api",
        typeof req.body?.reason === "string" ? req.body.reason : "owner-disable",
      );
      res.json(state);
    }),
  );

  app.post(
    "/api/platform-lock/subscription",
    requirePlatformOwner,
    asyncHandler(async (req: Request, res: Response) => {
      const state = await platformLockService.updateSubscriptionDates({
        actor: "platform-owner-api",
        subscriptionExpiresAt:
          req.body?.subscriptionExpiresAt === null
            ? null
            : typeof req.body?.subscriptionExpiresAt === "string"
              ? req.body.subscriptionExpiresAt
              : undefined,
        gracePeriodEndsAt:
          req.body?.gracePeriodEndsAt === null
            ? null
            : typeof req.body?.gracePeriodEndsAt === "string"
              ? req.body.gracePeriodEndsAt
              : undefined,
      });
      res.json(state);
    }),
  );

  // -------- Owner Portal (password-only session) --------
  app.post(
    "/api/platform-lock/portal/login",
    asyncHandler(async (req: Request, res: Response) => {
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!verifyOwnerPassword(password)) {
        throw new AuthenticationError("كلمة مرور المالك غير صحيحة");
      }
      const token = issueOwnerPortalToken();
      const state = await platformLockService.refresh();
      res.json({
        token,
        expiresInSec: 2 * 60 * 60,
        mode: state.mode,
        active: state.mode === "ACTIVE",
      });
    }),
  );

  app.get(
    "/api/platform-lock/portal/status",
    requireOwnerPortalSession,
    asyncHandler(async (_req: Request, res: Response) => {
      const state = await platformLockService.refresh();
      res.json({
        mode: state.mode,
        active: state.mode === "ACTIVE",
        publicMessage: platformLockService.getPublicMessage(state),
        systemLockVersion: state.systemLockVersion,
        updatedAt: state.updatedAt,
        stopWorkers: state.stopWorkers,
        revokeSessions: state.revokeSessions,
      });
    }),
  );

  app.post(
    "/api/platform-lock/portal/enable",
    requireOwnerPortalSession,
    asyncHandler(async (req: Request, res: Response) => {
      assertConfirmationPhrase(req.body?.confirmationPhrase);
      const mode = req.body?.mode as PlatformLockMode;
      if (!isPlatformLockMode(mode) || mode === "ACTIVE") {
        throw new ValidationError("mode must be MAINTENANCE | SUBSCRIPTION_SUSPENDED | SECURITY_LOCKDOWN");
      }
      const stopWorkers = mode === "SUBSCRIPTION_SUSPENDED" || mode === "SECURITY_LOCKDOWN"
        ? true
        : req.body?.stopWorkers !== false;
      const revokeSessions = mode === "SUBSCRIPTION_SUSPENDED" || mode === "SECURITY_LOCKDOWN"
        ? true
        : req.body?.revokeSessions !== false;

      const state = await platformLockService.enable({
        mode,
        lockedBy: "owner-portal",
        internalReason: typeof req.body?.internalReason === "string" ? req.body.internalReason : mode,
        stopWorkers,
        revokeSessions,
        suspensionReason: mode === "SUBSCRIPTION_SUSPENDED" ? "Suspended from owner portal" : undefined,
        ip: clientIp(req),
      });
      platformOpsService.pushLive(`${mode} enabled`);
      res.json(state);
    }),
  );

  app.post(
    "/api/platform-lock/portal/disable",
    requireOwnerPortalSession,
    asyncHandler(async (req: Request, res: Response) => {
      assertConfirmationPhrase(req.body?.confirmationPhrase);
      const state = await platformLockService.disable(
        "owner-portal",
        typeof req.body?.reason === "string" ? req.body.reason : "owner-portal-active",
        { ip: clientIp(req) },
      );
      platformOpsService.pushLive("Platform resumed (ACTIVE)");
      res.json(state);
    }),
  );

  app.get(
    "/api/platform-lock/portal/logs",
    requireOwnerPortalSession,
    asyncHandler(async (req: Request, res: Response) => {
      const limit = Number(req.query.limit || 40);
      const logs = await platformLockService.listAuditLogs(limit);
      res.json({ logs });
    }),
  );

  app.get(
    "/api/platform-lock/portal/ops",
    requireOwnerPortalSession,
    asyncHandler(async (_req: Request, res: Response) => {
      const snapshot = await platformOpsService.getSnapshot();
      res.json(snapshot);
    }),
  );

  app.get(
    "/api/platform-lock/portal/ops/history",
    requireOwnerPortalSession,
    asyncHandler(async (req: Request, res: Response) => {
      const rangeRaw = String(req.query.range || "1h");
      const range = rangeRaw === "24h" || rangeRaw === "7d" ? rangeRaw : "1h";
      res.json({ range, series: platformOpsService.getHistory(range) });
    }),
  );

  app.post(
    "/api/platform-lock/portal/restart-workers",
    requireOwnerPortalSession,
    asyncHandler(async (req: Request, res: Response) => {
      assertConfirmationPhrase(req.body?.confirmationPhrase);
      const result = await platformOpsService.restartWorkers("owner-portal", clientIp(req));
      if (!result.ok) throw new ValidationError(result.detail);
      res.json(result);
    }),
  );

  app.post(
    "/api/platform-lock/portal/backup-now",
    requireOwnerPortalSession,
    asyncHandler(async (req: Request, res: Response) => {
      assertConfirmationPhrase(req.body?.confirmationPhrase);
      const result = await platformOpsService.runBackupNow("owner-portal", clientIp(req));
      if (!result.ok) throw new ValidationError(result.detail);
      res.json(result);
    }),
  );

  app.post(
    "/api/platform-lock/portal/emergency-lock",
    requireOwnerPortalSession,
    asyncHandler(async (req: Request, res: Response) => {
      assertConfirmationPhrase(req.body?.confirmationPhrase);
      const state = await platformLockService.enable({
        mode: "SECURITY_LOCKDOWN",
        lockedBy: "owner-portal",
        internalReason: "emergency-lock",
        stopWorkers: true,
        revokeSessions: true,
        suspensionReason: "Emergency lockdown from owner portal",
        ip: clientIp(req),
      });
      platformOpsService.pushLive("EMERGENCY LOCK enabled");
      res.json(state);
    }),
  );
}
