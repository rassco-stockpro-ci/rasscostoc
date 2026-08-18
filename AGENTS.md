# AGENTS.md

## Cursor Cloud specific instructions

This is a single-product monorepo (npm workspaces + Turborepo) for **StockPro / Nulip**, an
Arabic (RTL) inventory-management system. It builds into **one Node process**: the Express API
(`apps/api`) also serves the React portal (`apps/portal`) through Vite middleware in dev. There is
no separate frontend server. Shared code lives in `packages/*` (schema/types in
`packages/shared-types`).

Standard commands live in the root `package.json` scripts and the `README.md`; use those. Key ones:
`npm run dev` (API + portal on `PORT=3001`), `npm run test:unit` (Vitest), `npm run check`
(typecheck), `npm run lint:architecture` (dependency-cruiser), `npm run db:migrate`.

### Services

| Service | Required | How to run | Notes |
|---|---|---|---|
| PostgreSQL | Yes | `sudo pg_ctlcluster 16 main start` | Not auto-started on boot; start it before the app/tests. DB `nulip_inventory`, user `postgres`/`postgres`. |
| Node app (API + portal) | Yes | `npm run dev` | Serves everything at http://localhost:3001. Runs Drizzle migrations on startup and seeds default data. |

### Non-obvious caveats

- **PostgreSQL must be started manually each session** (it is not a boot service):
  `sudo pg_ctlcluster 16 main start`. The database files persist on disk across sessions, so you do
  not need to recreate/re-migrate normally.
- **`.env` is required and git-ignored.** It persists on disk across sessions. It must contain
  `DATABASE_URL`, `SESSION_SECRET`, and **`JWT_SECRET`**. Note `JWT_SECRET` is enforced at module
  load (`apps/api/src/core/config/jwt.config.ts`) but is **missing from `env.example.txt`** — do not
  drop it. `PORT` is forced to 3001 by the `dev` script regardless of `.env`.
- **Default users are only seeded when the `users` table is empty** (see
  `BootstrapDefaults.use-case.ts`). Logins: `admin/admin123`, `supervisor1/super123`, `tech1/tech123`.
- **`npm run test:unit` runs against the real `DATABASE_URL`** and leaves rows behind (e.g. a
  `locking_test_user`). That non-empty `users` table then blocks default-user seeding on a fresh boot.
  If you need the default `admin` on an empty DB, seed before running the test suite, or recreate the
  DB: `sudo -u postgres psql -c "DROP DATABASE nulip_inventory;" && sudo -u postgres psql -c "CREATE DATABASE nulip_inventory;"`
  then restart `npm run dev` (it re-migrates and re-seeds).
- **API mutations require a CSRF header.** State-changing requests (POST/PUT/DELETE) must include
  `X-Requested-With: XMLHttpRequest` (or `X-CSRF-Token`), in addition to the session cookie or JWT.
- **Pre-existing failures unrelated to setup:** `npm run lint:architecture` reports ~20 dependency-cruiser
  violations and `npm run check` reports 1 TypeScript error on the committed `main` branch. The husky
  `pre-commit` hook runs `lint:architecture && test:unit`, so it fails on these pre-existing issues —
  commit with `git commit --no-verify` unless you intend to fix them.
- On startup you will see a transient `OutboxWorker ... relation "outbox_events" does not exist` error
  and a `feature_flags` fallback log; both are harmless startup races (the app migrates/falls back).
