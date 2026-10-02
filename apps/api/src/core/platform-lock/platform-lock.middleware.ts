import type { Request, Response, NextFunction } from "express";
import { platformLockService } from "./platform-lock.service";
import { isPlatformLockAllowlistedPath } from "./platform-lock.paths";
import { DEFAULT_PUBLIC_MESSAGES } from "./platform-lock.types";

function wantsHtml(req: Request): boolean {
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/html")) return true;
  if (req.method === "GET" && !req.path.startsWith("/api")) return true;
  return false;
}

function maintenanceHtml(message: string, mode: string): string {
  const safe = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>النظام غير متاح</title>
  <style>
    body { margin:0; font-family: "Segoe UI", Tahoma, sans-serif; background:#0B1F1F; color:#F8FAFB;
      display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
    .card { max-width:520px; width:100%; background:#122A2A; border:1px solid #18B2B033;
      border-radius:20px; padding:32px; text-align:center; box-shadow:0 20px 60px #0006; }
    h1 { margin:0 0 12px; font-size:1.5rem; color:#18B2B0; }
    p { margin:0; line-height:1.7; color:#D1D5DB; }
    .mode { margin-top:18px; font-size:12px; color:#6B7280; letter-spacing:.04em; }
  </style>
</head>
<body>
  <div class="card">
    <h1>النظام غير متاح حالياً</h1>
    <p>${safe}</p>
    <div class="mode">${mode}</div>
  </div>
</body>
</html>`;
}

/**
 * Central per-deployment lock gate.
 * Mount after session/auth plumbing is configured, and before business routes.
 */
export async function platformLockMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (isPlatformLockAllowlistedPath(req.path)) {
      next();
      return;
    }

    let state = platformLockService.getCachedState();
    // Refresh occasionally if we only have fail-closed default from empty cache
    if (!state || state.source === "fail-closed-default") {
      state = await platformLockService.refresh();
    }

    if (platformLockService.isActive(state)) {
      next();
      return;
    }

    const message = platformLockService.getPublicMessage(state) || DEFAULT_PUBLIC_MESSAGES.MAINTENANCE;

    res.setHeader("Retry-After", "300");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Platform-Lock-Mode", state.mode);

    if (wantsHtml(req)) {
      res.status(503).type("html").send(maintenanceHtml(message, state.mode));
      return;
    }

    res.status(503).json({
      error: "PLATFORM_LOCKED",
      mode: state.mode,
      message,
      statusCode: 503,
    });
  } catch {
    // Fail closed
    const message = DEFAULT_PUBLIC_MESSAGES.MAINTENANCE;
    res.setHeader("Retry-After", "300");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Platform-Lock-Mode", "MAINTENANCE");
    if (wantsHtml(req)) {
      res.status(503).type("html").send(maintenanceHtml(message, "MAINTENANCE"));
      return;
    }
    res.status(503).json({
      error: "PLATFORM_LOCKED",
      mode: "MAINTENANCE",
      message,
      statusCode: 503,
    });
  }
}
