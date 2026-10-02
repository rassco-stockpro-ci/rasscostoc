import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { app } from "./app";
import { initializeDatabase, getDatabase, closeDatabase } from "@core/database/connection";
import { pool } from "@core/config/db";
import { registerRoutes } from "./routes";
import { log } from "@core/utils/log";
import { serveStatic } from "@core/utils/static";
import { errorHandler } from "@core/errors/errorHandler";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { initializeEventSubscribers } from "./composition/events";
import { readinessManager } from "@core/telemetry/readiness";
import { configService } from "@core/config/config.service";
import { featureFlagService } from "@core/services/feature-flags.service";
import { closeSessionStore } from "@core/config/session";
import { lifecycleCoordinator } from "@core/lifecycle/lifecycle.coordinator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  try {
    // 0. Load Feature Flags
    log("⏳ Loading Feature Flags...");
    await featureFlagService.refresh();
    readinessManager.setFeatureFlagsLoaded(true);
    log("✅ Feature Flags loaded!");

    // 1. Register Event Subscribers
    initializeEventSubscribers();
    readinessManager.setSubscribersRegistered(true);

    // 1. Initialize database connection
    await initializeDatabase();
    readinessManager.setDBConnected(true);

    lifecycleCoordinator.register("sessionStore", () => closeSessionStore());
    lifecycleCoordinator.register("databasePool", () => closeDatabase());

    // 2. Programmatically apply Drizzle migrations on startup — one instance
    // at a time, and fail startup on genuine failure.
    // ERP-008 Phase 5: this block used to swallow any migration error and
    // continue "assuming schema already applied", so a genuinely broken
    // schema could pass readiness and serve traffic. The failure mode that
    // tolerance existed for was the multi-instance boot race (two instances
    // migrating concurrently); the session-level advisory lock below removes
    // that race — instances serialize, later ones find nothing left to
    // apply — so any error that still occurs is genuine and must halt
    // startup (the outer catch exits 1, which PM2 surfaces immediately)
    // rather than let this instance serve on an unknown schema.
    const migrationsFolder = fs.existsSync(path.resolve(process.cwd(), "migrations"))
      ? path.resolve(process.cwd(), "migrations")
      : path.resolve(__dirname, "../../../migrations");
    log(`⏳ Running database migrations from: ${migrationsFolder}`);
    const db = getDatabase();
    const MIGRATION_ADVISORY_LOCK_KEY = 823008; // shared constant, all instances
    const migrationLockClient = await pool.connect();
    try {
      await migrationLockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      await migrate(db, { migrationsFolder });
      log("✅ Database migrations completed successfully!");
    } finally {
      try {
        await migrationLockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      } finally {
        migrationLockClient.release();
      }
    }

    // Per-deployment lock: load state before workers (fail-closed if unreadable).
    // See apps/api/src/core/platform-lock/platform-lock.service.ts — this was a
    // fully-built original feature recovered from esbuild source maps embedded
    // in old server backups after its source vanished from git with no trace;
    // restored verbatim rather than reinvented.
    const { platformLockService } = await import("@core/platform-lock/platform-lock.service");
    const { outboxWorker } = await import("@core/outbox/outbox.worker");
    const { jobsWorker } = await import("@core/jobs/jobs.worker");

    platformLockService.setWorkerController({
      start: () => {
        outboxWorker.start();
        jobsWorker.start();
        readinessManager.setOutboxWorkerStarted(true);
        readinessManager.setJobsWorkerStarted(true);
      },
      stop: () => {
        jobsWorker.stop();
        outboxWorker.stop();
      },
    });
    lifecycleCoordinator.register("outboxWorker", () => outboxWorker.stop());
    lifecycleCoordinator.register("jobsWorker", () => jobsWorker.stop());

    const lockState = await platformLockService.initialize();
    log(`Platform lock mode: ${lockState.mode} (source=${lockState.source}, slv=${lockState.systemLockVersion})`);

    const { platformOpsService } = await import("@core/platform-lock/platform-lock.ops.service");
    platformOpsService.start();
    platformOpsService.pushLive("API Started");

    if (lockState.mode === "ACTIVE" || !lockState.stopWorkers) {
      outboxWorker.start();
      jobsWorker.start();
      readinessManager.setOutboxWorkerStarted(true);
      readinessManager.setJobsWorkerStarted(true);
    } else {
      log("Workers not started — platform lock stop_workers is active");
      readinessManager.setOutboxWorkerStarted(false);
      readinessManager.setJobsWorkerStarted(false);
    }

    // OPS-REMED-E4-P2: Courier Projection Worker follows the same
    // production platform-lock gate as the core background workers.
    const { courierProjectionWorker } = await import("@modules/courier/infrastructure/jobs/CourierProjectionWorker");
    if (lockState.mode === "ACTIVE" || !lockState.stopWorkers) {
      courierProjectionWorker.start();
      readinessManager.setCourierProjectionWorkerStarted(true);
      lifecycleCoordinator.register("courierProjectionWorker", () => courierProjectionWorker.stop());
    } else {
      log("Courier Projection Worker not started — platform lock stop_workers is active");
      readinessManager.setCourierProjectionWorkerStarted(false);
    }

    // 3. Register route modules
    const server = await registerRoutes(app);

    // 4. Global error handler middleware (must be registered after routes)
    app.use(errorHandler);

    // 5. Setup Vite development server or static file serving
    if (configService.isDevelopment) {
      // Dynamic import: the dev server pulls in the dev-only `vite` package,
      // which a production install (npm ci --omit=dev) does not contain.
      const { setupVite } = await import("@core/utils/vite");
      await setupVite(app, server);
    } else {
      await serveStatic(app);
    }

    // 6. Listen on specified PORT
    const port = configService.port;

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        log(`Port ${port} is already in use. Stop the other process or run with another port.`);
        process.exit(1);
      }
      log(`Server failed to start: ${error.message}`);
      process.exit(1);
    });

    server.listen(port, () => {
      log(`Server is serving on port ${port}`);

      lifecycleCoordinator.registerHttpServer(server);
      lifecycleCoordinator.setBeforeShutdown(() => readinessManager.setShuttingDown(true));

      // All critical resources are up and the listener is accepting
      // connections — only now is it safe to tell PM2 (wait_ready: true in
      // ecosystem.config.cjs) that this instance is actually ready.
      process.send?.("ready");
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Startup failed: ${message}`);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  lifecycleCoordinator.shutdown("SIGTERM").then(() => process.exit(process.exitCode ?? 0));
});
process.on("SIGINT", () => {
  lifecycleCoordinator.shutdown("SIGINT").then(() => process.exit(process.exitCode ?? 0));
});

startServer();
