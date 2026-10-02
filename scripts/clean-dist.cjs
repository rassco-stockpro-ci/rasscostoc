#!/usr/bin/env node
//
// Empties dist/ before a build, so an artifact contains only what this build
// produced (no stale chunks from earlier builds).
//
// Refuses when a running process executes this dist/server.js: rebuilding the
// directory a live server lazily loads chunks from breaks that server. Builds
// for production run in a release directory (scripts/atomic-deploy.sh), never
// in the live one.
//
// RELEASE_DIST_DIR overrides the directory (tests only).

const fs = require("fs");
const path = require("path");

const distDir = process.env.RELEASE_DIST_DIR
  ? path.resolve(process.env.RELEASE_DIST_DIR)
  : path.resolve(__dirname, "..", "dist");
const serverEntry = path.join(distDir, "server.js");

function processesUsing(entry) {
  if (process.platform !== "linux" || !fs.existsSync("/proc")) return [];
  const users = [];
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (args.some((arg) => path.resolve(cwd, arg) === entry)) users.push(Number(pid));
    } catch {
      // process exited or is not readable: not ours to inspect
    }
  }
  return users;
}

const users = processesUsing(serverEntry);
if (users.length > 0) {
  console.error(
    `clean-dist: REFUSED -- ${serverEntry} is running (PID ${users.join(", ")}). ` +
      "Build in a release directory (scripts/atomic-deploy.sh), not in the live one."
  );
  process.exit(1);
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
console.log(`clean-dist: emptied ${distDir}`);

// Workspace packages the server bundle loads at runtime are compiled by
// `build:packages` (tsc). tsc's incremental state (*.tsbuildinfo, git-ignored)
// can outlive their dist/ and make tsc emit nothing at all; clear both so
// every build compiles them from source. Skipped for test overrides.
if (!process.env.RELEASE_DIST_DIR) {
  const root = path.resolve(__dirname, "..");
  for (const rel of ["packages/ai-extraction/dist", "packages/ai-extraction/tsconfig.tsbuildinfo"]) {
    fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  }
  console.log("clean-dist: cleared workspace package build outputs (packages/ai-extraction)");
}
