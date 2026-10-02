/**
 * Release governance scripts (run by `npm run build` / `build:release`):
 *   write-release-sha.cjs   -- release identity is honest about a dirty tree
 *   clean-dist.cjs          -- dist is emptied, never while a server runs from it
 *   verify-runtime-deps.cjs -- the bundle needs only what `npm ci --omit=dev` installs
 *
 * Each script runs for real against a throwaway git repo / directory.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPTS = path.resolve(import.meta.dirname, "../../../../../scripts");

function run(script: string, opts: { cwd: string; env?: Record<string, string> }) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, script)], {
    cwd: opts.cwd,
    env: { ...process.env, RELEASE_REQUIRE_CLEAN: "", ...opts.env },
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("write-release-sha: the release identity represents the actual source state", () => {
  let repo: string;
  let dist: string;
  let head: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "release-sha-"));
    git("init", "-q");
    git("config", "user.email", "ci@test.local");
    git("config", "user.name", "ci");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), "dist/\n");
    git("add", ".");
    git("commit", "-qm", "init");
    head = git("rev-parse", "HEAD");
    dist = path.join(repo, "dist");
    fs.mkdirSync(dist);
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  const manifest = () => JSON.parse(fs.readFileSync(path.join(dist, "RELEASE_MANIFEST.json"), "utf8"));
  const releaseSha = () => fs.readFileSync(path.join(dist, "RELEASE_SHA"), "utf8").trim();

  it("clean tree: RELEASE_SHA is the commit, manifest says clean", () => {
    const r = run("write-release-sha.cjs", { cwd: repo, env: { RELEASE_DIST_DIR: dist } });
    expect(r.status).toBe(0);
    expect(releaseSha()).toBe(head);
    expect(manifest()).toMatchObject({ releaseSha: head, sourceSha: head, dirty: false, dirtyPathCount: 0, dirtyFingerprint: null });
    expect(manifest().node).toBe(process.version);
  });

  it("dirty tree: RELEASE_SHA is never the bare commit; the change is fingerprinted", () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "x\n");
    const r = run("write-release-sha.cjs", { cwd: repo, env: { RELEASE_DIST_DIR: dist } });
    expect(r.status).toBe(0);
    expect(releaseSha()).toBe(`${head}-dirty`);
    const m = manifest();
    expect(m).toMatchObject({ sourceSha: head, dirty: true, dirtyPathCount: 2 });
    expect(m.dirtyFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // A different uncommitted change gets a different fingerprint.
    fs.writeFileSync(path.join(repo, "untracked.txt"), "y\n");
    run("write-release-sha.cjs", { cwd: repo, env: { RELEASE_DIST_DIR: dist } });
    expect(manifest().dirtyFingerprint).not.toBe(m.dirtyFingerprint);
  });

  it("release mode refuses a dirty tree", () => {
    fs.rmSync(path.join(dist, "RELEASE_SHA"));
    const r = run("write-release-sha.cjs", { cwd: repo, env: { RELEASE_DIST_DIR: dist, RELEASE_REQUIRE_CLEAN: "1" } });
    expect(r.status).toBe(1);
    expect(r.out).toContain("REFUSED");
    expect(fs.existsSync(path.join(dist, "RELEASE_SHA"))).toBe(false);
  });
});

describe("clean-dist: an artifact contains only its own build", () => {
  it("empties dist", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "clean-dist-"));
    fs.writeFileSync(path.join(dist, "chunk-STALE.js"), "");
    const r = run("clean-dist.cjs", { cwd: dist, env: { RELEASE_DIST_DIR: dist } });
    expect(r.status).toBe(0);
    expect(fs.readdirSync(dist)).toEqual([]);
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it.runIf(process.platform === "linux")("refuses while a process runs that dist/server.js", async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "clean-dist-live-"));
    fs.writeFileSync(path.join(dist, "server.js"), "setInterval(() => {}, 1000);\n");
    const live = spawn(process.execPath, [path.join(dist, "server.js")], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const r = run("clean-dist.cjs", { cwd: dist, env: { RELEASE_DIST_DIR: dist } });
      expect(r.status).toBe(1);
      expect(r.out).toContain(`PID ${live.pid}`);
      expect(fs.existsSync(path.join(dist, "server.js"))).toBe(true);
    } finally {
      live.kill();
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe("verify-runtime-deps: the bundle loads only what a production install contains", () => {
  type Imp = { path: string; kind: string; external?: boolean };
  function fixture(imports: Imp[], chunks: Record<string, Imp[]> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-deps-"));
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "^4" }, devDependencies: { vite: "^5" } }));
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        packages: {
          "": { dependencies: { express: "^4" }, devDependencies: { vite: "^5" } },
          "apps/api": { name: "@stockpro/api", dependencies: { "@stockpro/ai-extraction": "*" } },
          "packages/ai-extraction": { name: "@stockpro/ai-extraction" },
          "node_modules/express": { version: "4.21.2" },
          "node_modules/vite": { version: "5.4.20", dev: true },
          "node_modules/transitive-only": { version: "1.0.0" },
          "node_modules/@stockpro/ai-extraction": { link: true, resolved: "packages/ai-extraction" },
        },
      })
    );
    // A built workspace package (removed by the test that needs it missing).
    fs.mkdirSync(path.join(root, "packages", "ai-extraction", "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "packages", "ai-extraction", "package.json"),
      JSON.stringify({ name: "@stockpro/ai-extraction", main: "./dist/index.js", exports: { ".": "./dist/index.js" } })
    );
    fs.writeFileSync(path.join(root, "packages", "ai-extraction", "dist", "index.js"), "export {};\n");
    const ext = (list: Imp[]) => list.map((i) => ({ external: true, ...i }));
    const outputs: Record<string, unknown> = {
      "dist/server.js": { entryPoint: "apps/api/src/server.ts", imports: ext(imports) },
    };
    // esbuild marks dynamic-import targets as entry points too
    for (const [file, list] of Object.entries(chunks)) outputs[file] = { entryPoint: `src/${file}`, imports: ext(list) };
    fs.writeFileSync(path.join(root, "dist", "meta.json"), JSON.stringify({ outputs }));
    return root;
  }
  const check = (imports: Imp[], chunks: Record<string, Imp[]> = {}) => {
    const root = fixture(imports, chunks);
    try {
      return run("verify-runtime-deps.cjs", { cwd: root, env: { RELEASE_ROOT: root } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it("passes for declared production deps, workspace packages, builtins and the dev-only dynamic vite chain", () => {
    const r = check([
      { path: "express", kind: "import-statement" },
      { path: "@stockpro/ai-extraction", kind: "import-statement" },
      { path: "node:fs", kind: "import-statement" },
      { path: "crypto", kind: "import-statement" },
      { path: "vite", kind: "dynamic-import" },
    ]);
    expect(r.status).toBe(0);
  });

  it("refuses a static import of a dev-only package (absent after npm ci --omit=dev)", () => {
    const r = check([{ path: "vite", kind: "import-statement" }]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("vite: statically imported");
  });

  it("a dev-only package inside a chunk loaded only through a dynamic import is allowed; the same chunk loaded at startup is not", () => {
    const devChunk = { "dist/vite-X.js": [{ path: "vite", kind: "import-statement" }] };
    const lazy = check([{ path: "dist/vite-X.js", kind: "dynamic-import", external: false }], devChunk);
    expect(lazy.status).toBe(0);

    const eager = check([{ path: "dist/vite-X.js", kind: "import-statement", external: false }], devChunk);
    expect(eager.status).toBe(1);
    expect(eager.out).toContain("vite: statically imported by dist/vite-X.js");
  });

  it("refuses a workspace package whose built entry is missing (stale incremental build)", () => {
    const root = fixture([{ path: "@stockpro/ai-extraction", kind: "import-statement" }]);
    try {
      fs.rmSync(path.join(root, "packages", "ai-extraction", "dist"), { recursive: true, force: true });
      const missing = run("verify-runtime-deps.cjs", { cwd: root, env: { RELEASE_ROOT: root } });
      expect(missing.status).toBe(1);
      expect(missing.out).toContain("packages/ai-extraction/dist/index.js not built");

      fs.mkdirSync(path.join(root, "packages", "ai-extraction", "dist"));
      fs.writeFileSync(path.join(root, "packages", "ai-extraction", "dist", "index.js"), "export {};\n");
      expect(run("verify-runtime-deps.cjs", { cwd: root, env: { RELEASE_ROOT: root } }).status).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a package present only transitively (not declared)", () => {
    const r = check([{ path: "transitive-only", kind: "import-statement" }]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("not declared");
  });
});
