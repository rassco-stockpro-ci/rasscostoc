import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import "dotenv/config";
import { db } from "@core/config/db";
import { coreJobs, users } from "@shared/schema";
import { jobsRepository } from "@core/jobs/jobs.repository";

/**
 * ERP-008 Phase 4 — genuine multi-process integration tests: spawns two
 * real, separate OS processes (not concurrent calls within one process,
 * which would share module-level state and hide exactly the bugs this
 * phase cares about), each running the full real middleware stack, and
 * proves cross-instance behavior over real HTTP.
 */

// Derived from this vitest process's own PID rather than hardcoded, so two
// rapid successive test runs (e.g. back-to-back Husky pre-commit runs) get
// different ports instead of colliding on a port the previous run's child
// process hasn't fully released yet (observed directly during development).
const BASE_PORT = 20000 + (process.pid % 10000);
const PORT_A = BASE_PORT;
const PORT_B = BASE_PORT + 1;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");
const WORKER_PATH = path.resolve(import.meta.dirname, "multi-instance-worker.ts");

function startWorker(port: number, instanceId: string, extraArg?: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const args = [WORKER_PATH, String(port), instanceId];
    if (extraArg) args.push(extraArg);
    // shell: true is required for reliable cross-platform npx resolution
    // (Windows needs npx.cmd via PATH lookup); safe here since every
    // argument is a hardcoded constant, never user input. Note: this
    // creates a cmd.exe -> tsx -> node chain on Windows, so shutdown is
    // primarily done over HTTP (POST /__shutdown, see afterAll) — killing
    // by PID only terminates the cmd.exe wrapper and orphans the real node
    // process underneath, which left processes holding the test ports
    // across runs. killProcessTree() below is only a best-effort fallback.
    const child = spawn("npx", ["tsx", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      cwd: REPO_ROOT,
    });
    let stderrOutput = "";
    child.stderr.on("data", (d) => { stderrOutput += d.toString(); });
    // 60s, not 15s: each worker cold-compiles the app's whole import graph
    // through tsx, and two of them start in parallel while the rest of the
    // suite is still running — 15s was routinely exceeded under full-suite
    // load (the recurring pre-commit flake), while being generous here costs
    // nothing when the machine is idle.
    const timeout = setTimeout(
      () => reject(new Error(`worker ${instanceId} did not become ready in time. stderr: ${stderrOutput}`)),
      60000
    );
    child.stdout.on("data", (d) => {
      if (d.toString().includes("WORKER_READY")) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.on("error", reject);
  });
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

async function getReq(port: number, path: string, cookie?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.get("set-cookie") };
}

async function postReq(port: number, path: string, cookie?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.get("set-cookie") };
}

describe("ERP-008 Phase 4 — multi-process integration", () => {
  let workerA: ChildProcess;
  let workerB: ChildProcess;

  beforeAll(async () => {
    [workerA, workerB] = await Promise.all([
      startWorker(PORT_A, "A", "with-jobs-worker"),
      startWorker(PORT_B, "B", "with-jobs-worker"),
    ]);
  }, 90000);

  afterAll(async () => {
    await Promise.allSettled([
      postReq(PORT_A, "/__shutdown"),
      postReq(PORT_B, "/__shutdown"),
    ]);
    // Belt-and-suspenders in case a worker didn't respond (e.g. crashed, or
    // beforeAll itself never got far enough to assign it) — best-effort,
    // errors ignored; killProcessTree() already no-ops on an undefined pid.
    if (workerA) killProcessTree(workerA);
    if (workerB) killProcessTree(workerB);
  });

  it("a session created on instance A is recognized on instance B, and logout on B invalidates it on A", async () => {
    const loginRes = await postReq(PORT_A, "/login");
    const cookie = loginRes.setCookie?.split(";")[0];
    expect(cookie).toBeTruthy();

    const whoamiB = await getReq(PORT_B, "/whoami", cookie);
    expect(whoamiB.status).toBe(200);
    expect(whoamiB.body.loggedIn).toBe(true);

    const logoutB = await postReq(PORT_B, "/logout", cookie);
    expect(logoutB.status).toBe(200);

    const whoamiA = await getReq(PORT_A, "/whoami", cookie);
    expect(whoamiA.status).toBe(401);
  }, 20000);

  it("two real processes claiming jobs concurrently never claim the same job", async () => {
    await db.delete(coreJobs);
    const [existingUser] = await db.select().from(users).limit(1);
    const ownerId = existingUser?.id ?? "test-owner-p4-multiproc";
    if (!existingUser) {
      await db.insert(users).values({
        id: ownerId,
        username: "p4multiproc",
        fullName: "P4 Multiproc",
        email: "p4multiproc@example.com",
        role: "admin",
        password: "mock-hash",
      });
    }
    for (let i = 0; i < 4; i++) {
      await jobsRepository.createJob({ type: "P4_MULTI_PROC_JOB", ownerId });
    }

    const claims = await Promise.all([
      postReq(PORT_A, "/claim-job"),
      postReq(PORT_B, "/claim-job"),
      postReq(PORT_A, "/claim-job"),
      postReq(PORT_B, "/claim-job"),
    ]);
    const claimedIds = claims.map((c) => c.body?.claimed).filter(Boolean);
    const uniqueIds = new Set(claimedIds);

    expect(claimedIds.length).toBeGreaterThan(0);
    expect(uniqueIds.size).toBe(claimedIds.length);
  }, 20000);
});
