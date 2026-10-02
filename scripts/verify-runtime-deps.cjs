#!/usr/bin/env node
//
// The server bundle leaves npm packages external (esbuild --packages=external),
// so they are resolved from node_modules at runtime. A production install is
// `npm ci --omit=dev` (scripts/atomic-deploy.sh). This check proves, from the
// build's own metafile and the lockfile, that every package the bundle loads
// at startup will be present in that install:
//
//   * packages loaded at startup (static imports reachable from the entry) must
//     be declared in "dependencies" of the root or of a workspace package, and
//     installed as non-dev in the lockfile (transitive presence does not count:
//     it can disappear on any upgrade);
//   * packages loaded lazily (behind a dynamic import) must meet the same rule,
//     unless listed in DEV_ONLY_DYNAMIC (code paths that run in development
//     only).
//
// RELEASE_DIST_DIR / RELEASE_ROOT override the locations (tests only).

const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");

const root = process.env.RELEASE_ROOT ? path.resolve(process.env.RELEASE_ROOT) : path.resolve(__dirname, "..");
const distDir = process.env.RELEASE_DIST_DIR ? path.resolve(process.env.RELEASE_DIST_DIR) : path.join(root, "dist");

/** Dev server chain, loaded only under configService.isDevelopment (server.ts). */
const DEV_ONLY_DYNAMIC = new Set([
  "vite",
  "@vitejs/plugin-react",
  "@replit/vite-plugin-runtime-error-modal",
  "@replit/vite-plugin-cartographer",
  "@replit/vite-plugin-dev-banner",
]);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const packageName = (spec) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
const builtins = new Set(builtinModules);

const meta = readJson(path.join(distDir, "meta.json"));
const lock = readJson(path.join(root, "package-lock.json"));
const rootPkg = readJson(path.join(root, "package.json"));

// Directly declared production dependencies: root + every workspace package.
const declared = new Set(Object.keys(rootPkg.dependencies ?? {}));
const workspaceNames = new Set();
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (key && !key.startsWith("node_modules/") && entry && entry.name) {
    workspaceNames.add(entry.name);
    for (const dep of Object.keys(entry.dependencies ?? {})) declared.add(dep);
  }
}

const installedNonDev = (name) => {
  const entry = lock.packages?.[`node_modules/${name}`];
  return !!entry && entry.dev !== true && entry.devOptional !== true;
};

// Which output files load at startup: the entry points plus everything they
// reach through static imports. Anything else is loaded lazily, behind a
// dynamic import.
const outputs = meta.outputs ?? {};
const startup = new Set();
const visit = (file) => {
  if (startup.has(file) || !outputs[file]) return;
  startup.add(file);
  for (const imp of outputs[file].imports ?? []) {
    if (!imp.external && imp.kind === "import-statement") visit(imp.path);
  }
};
// esbuild also marks every dynamic-import target as an entryPoint; the real
// roots are the entry points nothing loads dynamically (the server entry).
const lazilyLoaded = new Set();
for (const info of Object.values(outputs)) {
  for (const imp of info.imports ?? []) {
    if (!imp.external && imp.kind === "dynamic-import") lazilyLoaded.add(imp.path);
  }
}
for (const [file, info] of Object.entries(outputs)) {
  if (info.entryPoint && !lazilyLoaded.has(file)) visit(file);
}

// staticImports: packages loaded at startup. dynamicImports: packages loaded
// only on a lazy path (a dynamic import, or a chunk only reachable through one).
const staticImports = new Map();
const dynamicImports = new Map();
for (const [output, info] of Object.entries(outputs)) {
  for (const imp of info.imports ?? []) {
    if (!imp.external) continue;
    const name = packageName(imp.path);
    if (imp.path.startsWith("node:") || builtins.has(name)) continue;
    const atStartup = startup.has(output) && imp.kind === "import-statement";
    const bucket = atStartup ? staticImports : dynamicImports;
    if (!bucket.has(name)) bucket.set(name, output);
  }
}

// Directory of each workspace package, by name (lockfile keys are paths).
const workspaceDirs = new Map();
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (key && !key.startsWith("node_modules/") && entry && entry.name) workspaceDirs.set(entry.name, key);
}

/** A workspace package is loaded from its built entry (main / exports["."]), which must exist. */
function missingWorkspaceEntry(name) {
  const dir = workspaceDirs.get(name);
  if (!dir) return null;
  const pkgFile = path.join(root, dir, "package.json");
  if (!fs.existsSync(pkgFile)) return `${dir}/package.json missing`;
  const pkg = readJson(pkgFile);
  const dot = pkg.exports && (typeof pkg.exports === "string" ? pkg.exports : pkg.exports["."]);
  const entry = (typeof dot === "string" ? dot : dot?.import ?? dot?.default) ?? pkg.main;
  if (!entry) return null;
  return fs.existsSync(path.join(root, dir, entry)) ? null : `${dir}/${entry.replace(/^\.\//, "")} not built`;
}

const problems = [];
for (const [name, output] of staticImports) {
  if (workspaceNames.has(name)) {
    if (!declared.has(name)) problems.push(`${name}: workspace package imported by ${output} but not declared as a dependency`);
    const missing = missingWorkspaceEntry(name);
    if (missing) problems.push(`${name}: imported by ${output} but its entry is absent (${missing})`);
    continue;
  }
  if (!declared.has(name)) {
    problems.push(`${name}: statically imported by ${output} but not declared in "dependencies" (root or workspace)`);
  } else if (!installedNonDev(name)) {
    problems.push(`${name}: statically imported by ${output} but the lockfile installs it as dev-only (absent after npm ci --omit=dev)`);
  }
}
for (const [name, output] of dynamicImports) {
  if (workspaceNames.has(name) || DEV_ONLY_DYNAMIC.has(name)) continue;
  if (!declared.has(name) || !installedNonDev(name)) {
    problems.push(`${name}: dynamically imported by ${output} but not a declared, non-dev dependency`);
  }
}

if (problems.length > 0) {
  console.error("verify-runtime-deps: REFUSED -- the bundle loads packages a production install would not contain:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `verify-runtime-deps: ${staticImports.size} static + ${dynamicImports.size} dynamic external packages, all present in a production install`
);
