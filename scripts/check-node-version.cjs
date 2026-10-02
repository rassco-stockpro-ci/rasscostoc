#!/usr/bin/env node
//
// The build runs only on the pinned Node version (.nvmrc) -- the same version
// CI uses (setup-node node-version-file) and production runs.
//
// ALLOW_NODE_MISMATCH=1 lets a local, non-release build proceed with a
// warning; it is ignored when RELEASE_REQUIRE_CLEAN=1 (release builds).

const fs = require("fs");
const path = require("path");

const nvmrc = path.resolve(__dirname, "..", ".nvmrc");
const pinned = fs.readFileSync(nvmrc, "utf8").trim().replace(/^v/, "");
const running = process.versions.node;

if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
  console.error(`check-node-version: .nvmrc must pin an exact version (x.y.z), found "${pinned}"`);
  process.exit(1);
}

if (running === pinned) {
  console.log(`check-node-version: Node ${running} matches .nvmrc`);
  process.exit(0);
}

const release = process.env.RELEASE_REQUIRE_CLEAN === "1";
if (process.env.ALLOW_NODE_MISMATCH === "1" && !release) {
  console.warn(`check-node-version: WARNING -- Node ${running} != pinned ${pinned} (ALLOW_NODE_MISMATCH=1, not a release build)`);
  process.exit(0);
}

console.error(`check-node-version: REFUSED -- Node ${running} != pinned ${pinned} (.nvmrc).`);
process.exit(1);
