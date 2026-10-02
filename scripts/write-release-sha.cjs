#!/usr/bin/env node
//
// Writes the release identity of a build into dist/:
//
//   dist/RELEASE_SHA            the 40-char commit SHA when the source tree is
//                               clean; "<sha>-dirty" when it is not, so a
//                               build from uncommitted changes can never pass
//                               for that commit (pre-deploy-guard rejects it)
//   dist/RELEASE_MANIFEST.json  source SHA, dirty flag + fingerprint of the
//                               uncommitted changes, Node/npm versions,
//                               lockfile hash, build time
//
// RELEASE_REQUIRE_CLEAN=1 (set by `npm run build:release`) refuses to label a
// dirty tree at all: the build fails instead.
//
// The SHA is always derived from git, never from a caller-supplied variable.
// RELEASE_DIST_DIR overrides the output directory (tests only).
//
// Exits non-zero (failing the build) if the SHA cannot be determined, dist/
// does not exist yet, or a clean tree is required and the tree is dirty.

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

let sha;
try {
  sha = git(["rev-parse", "HEAD"]).trim();
} catch (err) {
  console.error("write-release-sha: failed to determine git HEAD SHA:", err.message);
  process.exit(1);
}

if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`write-release-sha: git rev-parse HEAD returned an invalid SHA: "${sha}"`);
  process.exit(1);
}

const root = git(["rev-parse", "--show-toplevel"]).trim();
const distDir = process.env.RELEASE_DIST_DIR
  ? path.resolve(process.env.RELEASE_DIST_DIR)
  : path.resolve(__dirname, "..", "dist");
if (!fs.existsSync(distDir)) {
  console.error("write-release-sha: dist/ does not exist -- the build must run before this script.");
  process.exit(1);
}

// Every tracked change, staged or not, and every untracked, non-ignored file.
const status = git(["status", "--porcelain=v1", "--untracked-files=all"])
  .split("\n")
  .filter(Boolean);
const dirty = status.length > 0;

if (dirty && process.env.RELEASE_REQUIRE_CLEAN === "1") {
  console.error(
    `write-release-sha: REFUSED -- the source tree has ${status.length} uncommitted path(s); ` +
      "a release build must come from a clean commit."
  );
  for (const line of status.slice(0, 20)) console.error(`  ${line}`);
  process.exit(1);
}

// Fingerprint of exactly what differs from HEAD: the tracked diff plus the
// content of every untracked file, so two different dirty trees on the same
// commit never share an identity.
let dirtyFingerprint = null;
if (dirty) {
  const hash = crypto.createHash("sha256");
  hash.update(git(["diff", "HEAD", "--binary"]));
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean).sort();
  for (const file of untracked) {
    hash.update(`\0${file}\0`);
    try {
      hash.update(fs.readFileSync(path.join(root, file)));
    } catch {
      hash.update("<unreadable>");
    }
  }
  dirtyFingerprint = hash.digest("hex");
}

const lockfile = path.join(root, "package-lock.json");
let npmVersion = null;
try {
  npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
} catch {
  // npm absent from PATH: recorded as null
}

const releaseSha = dirty ? `${sha}-dirty` : sha;
const manifest = {
  releaseSha,
  sourceSha: sha,
  dirty,
  dirtyPathCount: status.length,
  dirtyFingerprint,
  node: process.version,
  npm: npmVersion,
  lockfileSha256: fs.existsSync(lockfile) ? sha256(fs.readFileSync(lockfile)) : null,
  builtAt: new Date().toISOString(),
};

fs.writeFileSync(path.join(distDir, "RELEASE_SHA"), releaseSha + "\n", { encoding: "utf8" });
fs.writeFileSync(path.join(distDir, "RELEASE_MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", {
  encoding: "utf8",
});

if (dirty) {
  console.warn(
    `write-release-sha: WARNING -- built from a dirty tree (${status.length} uncommitted path(s)); ` +
      `wrote dist/RELEASE_SHA = ${releaseSha}. This artifact is not a release of ${sha} and will be rejected by pre-deploy-guard.`
  );
} else {
  console.log(`write-release-sha: wrote dist/RELEASE_SHA = ${releaseSha}`);
}
