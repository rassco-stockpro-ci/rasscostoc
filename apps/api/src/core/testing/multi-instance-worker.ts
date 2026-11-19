/**
 * ERP-008 Phase 4 — multi-process test worker. Boots a minimal real
 * Express app (real rateLimiter middleware, real setupSession, real
 * JobsWorker) on a given port, so a test can spawn two genuinely separate
 * OS processes and prove (or disprove) cross-instance behavior. A
 * same-process concurrent-call test cannot do this for module-level state
 * like the rate limiter's ipStore, since two "workers" in the same process
 * would share the same Node module registry — this file exists specifically
 * to be spawned as its own process, not imported.
 *
 * Usage: tsx multi-instance-worker.ts <port> <instanceId> [with-jobs-worker]
 */
import "dotenv/config";
process.env.NODE_ENV = "production"; // rateLimiter is a no-op outside production
process.env.BYPASS_OUTBOX = "false";
// This worker binds to plain HTTP; prevent cookie.secure=true which would make
// express-session skip Set-Cookie entirely (shouldSetCookie returns false when
// secure=true but req.secure=false).  TRUST_PROXY=true from .env would flip
// isHttps=true inside setupSession, so clear both flags explicitly.
delete process.env.TRUST_PROXY;
process.env.HTTPS = "false";

import express from "express";
import { rateLimiter } from "@core/middlewares/security.middleware";
import { setupSession } from "@core/config/session";
import { pool } from "@core/config/db";
import { jobsWorker } from "@core/jobs/jobs.worker";
import { jobsRepository } from "@core/jobs/jobs.repository";
import { jobsRegistry } from "@core/jobs/jobs.registry";

// session.ts already augments express-session's SessionData with the real
// `user` shape ({id, role, username, regionId}) — reuse that, don't redeclare.

const port = Number(process.argv[2]);
const instanceId = process.argv[3] || "unknown";

const app = express();
app.use(rateLimiter);
app.use(express.json());
setupSession(app);

app.post("/login", (req, res) => {
  req.session.user = { id: "user-1", role: "admin", username: "tester", regionId: null };
  req.session.save(() => {
    res.json({ ok: true, instance: instanceId });
  });
});

app.get("/whoami", (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user, instance: instanceId });
  } else {
    res.status(401).json({ loggedIn: false, instance: instanceId });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true, instance: instanceId });
  });
});

app.get("/ping", (_req, res) => {
  res.json({ instance: instanceId });
});

// Test-only: lets the harness shut this worker down over HTTP instead of
// killing it by PID — on Windows, killing a shell-spawned process by PID
// only terminates the immediate cmd.exe wrapper and orphans the real node
// process underneath (confirmed: taskkill /T did not reliably reach it
// either), which left processes holding the port across test runs.
app.post("/__shutdown", (_req, res) => {
  res.json({ ok: true, instance: instanceId });
  setTimeout(() => process.exit(0), 50);
});

if (process.argv[4] === "with-jobs-worker") {
  jobsRegistry.register("P4_MULTI_PROC_JOB", async () => {
    await new Promise((r) => setTimeout(r, 100));
    return "done";
  });
  jobsWorker.start();

  app.post("/claim-job", async (_req, res) => {
    const job = await jobsRepository.claimNextJob();
    res.json({ claimed: job ? job.id : null, instance: instanceId });
  });
}

// Warm up the pool so the session store can save on the very first request.
// Without this, connect-pg-simple's first save races against the pool's
// initial connection and fails silently, causing no Set-Cookie header.
pool.query("SELECT 1").then(() => {
  app.listen(port, () => {
    console.log(`WORKER_READY instance=${instanceId} port=${port}`);
  });
}).catch((err: Error) => {
  console.error(`WORKER_DB_ERROR: ${err.message}`);
  process.exit(1);
});
