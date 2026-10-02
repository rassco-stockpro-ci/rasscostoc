import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { initializeDefaults } from "@modules/inventory/presentation/routes/bootstrap";
import { registerIdentityRoutes } from "@modules/identity/presentation/routes/index";
import { registerInventoryRoutes } from "@modules/inventory/presentation/routes/index";
import { registerAccountingRoutes } from "@modules/accounting/presentation/routes/accounting.routes";
import { registerCourierRoutes } from "@modules/courier/presentation/routes/courier.routes";
import { registerPermissionsRoutes } from "@modules/permissions/presentation/routes/permissions.routes";
import { registerAiEngineSettingsRoutes } from "@modules/ai-engine-settings/ai-engine-settings.routes";
import { readinessManager } from "@core/telemetry/readiness";
import { metrics } from "@core/telemetry/metrics";
import { getRecentSpans } from "@core/telemetry/tracer";
import { requireAdminOrInternal, requireAuth } from "@core/middlewares/auth.middleware";
import { platformLockMiddleware } from "@core/platform-lock/platform-lock.middleware";
import { registerPlatformLockRoutes } from "@core/platform-lock/platform-lock.routes";

export async function registerRoutes(app: Express): Promise<Server> {
  // Initialize default data on startup
  await initializeDefaults();

  /** Safe public liveness — no environment / dependency details. */
  const healthHandler = (_req: Request, res: Response) => {
    res.json({
      status: "healthy",
      service: "stockpro-api",
      timestamp: new Date().toISOString(),
    });
  };

  app.get("/api/health", healthHandler);
  app.get("/health", healthHandler);

  app.get("/health/live", (_req, res) => {
    res.json({ status: "UP" });
  });

  /** Public ready probe — status only (no internal details). */
  app.get("/health/ready", (_req, res) => {
    const ready = readinessManager.isReady();
    if (ready) {
      res.json({ status: "UP" });
    } else {
      res.status(503).json({ status: "DOWN" });
    }
  });

  // Owner control + public lock status (allowlisted; auth is secret-based,
  // not tied to any app user account — see platform-lock.service.ts).
  registerPlatformLockRoutes(app);

  // Central per-deployment lock — after health/owner routes, before every
  // other business route (including identity/inventory/accounting/courier
  // and the leads-audit + AI-engine routes registered further below).
  app.use(platformLockMiddleware);

  // PLATFORM-P0 — observability requires admin or internal service key
  app.get("/api/observability/metrics", requireAdminOrInternal, (_req, res) => {
    res.json(metrics.getAllMetrics());
  });

  /** ERP-001 / Sprint 1.5: client timings (authenticated users only). */
  app.post("/api/observability/client-timing", requireAuth, (req, res) => {
    const body = req.body || {};
    const page = typeof body.page === "string" ? body.page : "";

    const record = (metricName: string, value: unknown) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 60_000) return;
      metrics.recordValue(metricName, value);
      if (page) metrics.recordValue(`${metricName}_${page}`, value);
    };

    record(typeof body.name === "string" && body.name ? body.name : "courier_client_render_ms", body.renderMs);
    record("courier_client_network_ms", body.networkMs);
    record("courier_client_ttfb_ms", body.ttfbMs);
    record("courier_client_paint_ms", body.paintMs);
    if (typeof body.transferSize === "number" && body.transferSize > 0 && body.transferSize < 50_000_000) {
      metrics.recordValue("courier_client_transfer_bytes", body.transferSize);
    }

    res.status(204).end();
  });

  app.get("/api/observability/spans", requireAdminOrInternal, (_req, res) => {
    res.json(getRecentSpans());
  });

  app.get("/api/observability/ready", requireAdminOrInternal, (_req, res) => {
    const ready = readinessManager.isReady();
    const details = readinessManager.getDetails();
    if (ready) {
      res.json({ status: "UP", details });
    } else {
      res.status(503).json({ status: "DOWN", details });
    }
  });

  // Config endpoint for Flutter app dynamic base URL
  app.get("/api/config", (_req, res) => {
    let host = _req.get("host") || "localhost:3001";
    if (host.includes("127.0.0.1") || host.includes("localhost")) {
      host = host.replace("127.0.0.1", "10.0.2.2").replace("localhost", "10.0.2.2");
    }
    res.json({
      baseUrl: `${_req.protocol}://${host}`,
    });
  });

  // Register identity routes
  registerIdentityRoutes(app);

  // Register Permission Engine / Permissions Center routes (OPS-PERM-S1-F4)
  registerPermissionsRoutes(app);

  // Register inventory routes
  registerInventoryRoutes(app);

  // Register accounting routes
  registerAccountingRoutes(app);

  // Register courier routes
  registerCourierRoutes(app);

  // Register async job routes
  const { registerJobRoutes } = await import("@core/jobs/jobs.routes");
  registerJobRoutes(app);

  // AI Engine provider settings (admin) — PR-006A-10
  registerAiEngineSettingsRoutes(app);

  // Register lead discovery audit routes
  const { registerLeadDiscoveryAuditRoutes } = await import("./modules/leads/leads-audit.routes");
  registerLeadDiscoveryAuditRoutes(app);

  const httpServer = createServer(app);
  return httpServer;
}
