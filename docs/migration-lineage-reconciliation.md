# Migration lineage reconciliation

Production's migration ledger and `main`'s journal diverged. This change makes
`main` able to migrate a Production database forward with the real migrator,
and makes a database built from `main` contain everything Production has.

Nothing here has been run against Production. See "Not done" below.

## What diverged

| | Production | main |
|---|---|---|
| `0049` | `platform_lock_state` (Production-only file) | `courier_execution_custody_closure_status_add` |
| `0050`-`0055` | = main `0049`-`0054`, byte-identical (SHA-256), numbered one higher | |
| `0055`-`0060` | not applied (objects absent) | `region_id`, region FK validate, `assigned_to_user_id`, `auth_generation`, permission engine, execution units |
| ledger high-water mark | `created_at = 1785826886000` | `0055` has `when = 1785826886000` |

drizzle's migrator applies a migration only if its `when` is **strictly greater**
than the last ledger row. On a Production-shaped ledger that means:

* `0055` (`region_id`, FK `NOT VALID`, index) is skipped;
* `0056` (`VALIDATE CONSTRAINT` on that FK) is not, and fails;
* the whole run rolls back, so nothing is applied.

Registering `0060` by hand would not have helped: it would have moved the
high-water mark past `0056`-`0059`, which would then never run.

## What this PR adds (additive only; no existing file or timestamp is edited)

| Entry | `when` | Purpose |
|---|---|---|
| `0061_courier_requests_region_id_add_reconcile` | `1785826886500` (above Production's mark, below `0056`) | Guarded, idempotent restatement of `0055`: `ADD COLUMN IF NOT EXISTS`, FK added only if absent (`NOT VALID`), `CREATE INDEX IF NOT EXISTS`. Placed in the journal between `0055` and `0056`. |
| `0062_platform_lock_state_baseline` | `1787840003000` | `CREATE TABLE IF NOT EXISTS platform_lock_state` in Production's real column set. No seed row. |

* Production-shaped database: `0055` is skipped by the migrator, `0061` applies
  the same objects, then `0056`-`0060`, then `0062` (a no-op: the table exists).
* Fresh database / database already migrated by main: `0061` and the existing
  table make every statement a no-op.
* Every ledger row is written by drizzle's migrator. A Production-shaped
  ledger ends up without a row for `0055`; its objects are covered by `0061`.
* `idx` for the two new entries is 61/62 (their file numbers); journal order,
  not `idx`, is what the migrator follows.

Note on `0058`: it is the one migration with a data effect. It sets
`auth_generation = 1` for inactive users and deletes their `bearer_sessions`
rows. The rehearsal proves that this is the only row removal.

## Proof: `scripts/migration-lineage-rehearsal.mjs`

Runs in CI (job *Migration from zero + drift check*) and locally
(`npm run db:lineage:rehearsal`, needs `TEST_DATABASE_URL` to a disposable
server). It refuses to run without `--allow-test-db` or against a database name
without "test".

1. Production snapshot: `--synthetic` replays Production's lineage into a
   throwaway database (main 0000-0048, Production's `0049_platform_lock_state`,
   main 0049-0054 as Production's 0050-0055 with `when` + 1000) and seeds rows;
   `--snapshot-dump FILE` restores a real verified `pg_dump` instead.
2. Runs the real `scripts/migrate.ts`; asserts exactly `0061, 0056-0060, 0062`
   were added, in order, with the journal's `when`, existing ledger rows
   untouched, and each migration's objects present.
3. Row fingerprints (md5 over the pre-existing columns of every table) are
   identical before and after, except `bearer_sessions` (0058's deliberate
   delete, checked row-for-row).
4. Second run: ledger, schema catalog and all data unchanged (NO-OP).
5. A from-zero database: ledger row count equals the journal; `platform_lock_state`
   exists with the same columns/constraints/indexes as Production's.
6. Drift: catalog diff (tables, columns, constraints, indexes, sequences,
   functions, triggers) of reconciled vs from-zero. Synthetic mode requires
   zero differences; snapshot mode requires that reconciliation introduces none
   and lists what was already different.

Negative controls (each turns the rehearsal red): reconcile entry removed;
baseline removed; constraint guard disabled; reconcile migration deleting a
business row; reconcile `when` below the high-water mark.

## Findings the rehearsal on the real snapshot surfaced (not caused by this change)

The restored Production backup also differs from `main` from zero in ways that
have nothing to do with the lineage (227 catalog lines, identical before and
after this change):

* the accounting/e-invoice tables use `varchar(64)` ids and different
  constraint names (`*_key` vs `*_unique`, `*_fkey` vs `*_id_fk`);
* about 50 secondary indexes that `main` creates are absent in Production
  (e.g. `received_devices_*`, `stock_movements_*`, `technician_product_stock.tech_product_unique`);
* the table `idempotency_keys`, which `core/middlewares/idempotency.middleware.ts`
  reads and writes, does not exist in Production.

These need their own decision before a backend deploy. They are listed, not fixed.

## Not done

* No migration, ledger write, deploy, restart or data change on Production.
* Production's own `0049_platform_lock_state` file also declares
  `platform_ops_snapshots`; that table is absent from the Production database
  and is not reproduced here.

## Runtime dependency reconciliation (0063)

A read-only runtime review of `main` against the reconciled Production schema
(every drizzle table/column, every raw-SQL table, every `ON CONFLICT` target)
found two objects the backend uses that Production lacks. Both are created
early in main's chain (`0001`, `0004`), so a from-zero database already has
them; `0063_runtime_dependency_reconcile` (`when 1787840004000`) restates them
with guards:

| Object | Used by | Without it on Production |
|---|---|---|
| `tech_product_unique` on `technician_product_stock (technician_id, product_id)` | `DrizzleTechnicianProductStockRepository.setBalance()` `ON CONFLICT` target, reached from `POST /representative/inventory/sale` | that request fails every time (no unique index matches the `ON CONFLICT` target); the unit of work rolls back |
| `idempotency_keys` (shape of `0001`) | global `idempotency` middleware, only for POST/PUT/PATCH carrying `x-idempotency-key` | the middleware fails open: the request runs without duplicate protection |

`technician_product_stock` is empty on Production, so the unique index cannot
fail there. No row is read or changed.

`scripts/on-conflict-audit.ts` reads every `ON CONFLICT` target from the
backend source (drizzle `onConflictDo*({ target })` resolved through the shared
schema, and raw `INSERT ... ON CONFLICT (...)`) and fails if any target has no
matching unique index. The rehearsal runs it before reconciliation (it must
report exactly the `technician_product_stock` gap), after reconciliation and on
the from-zero database (both must report none).

### Startup behaviour (observed, not changed)

`server.ts` starts the outbox, jobs and courier-projection workers, then runs
`migrate()` under an advisory lock, then registers routes and listens. The
built backend was booted against a restored Production backup with no network
(`unshare -n`, database over a unix socket) and Postgres statement logging:

* migrations ran in one transaction on their own connection (about 120 ms);
* during that window the other connections ran only the outbox worker's first
  poll (`outbox_events`) and the projection worker's claim
  (`inventory_deduction_completions`); neither table is touched by a pending
  migration, and no worker statement referenced an object the migrations
  create;
* routes were registered only after the commit; the only error logged was the
  pre-existing missing `feature_flags` table (the service falls back to
  defaults);
* row counts were unchanged across the boot; the startup accounting seed
  (`chart_of_accounts` / `tax_codes`) left the rows identical.

Note: Production's `.env` sets `RUN_DB_MIGRATIONS_ON_STARTUP=false`, but no
code in `main` (or in Production's current build) reads that variable:
startup always migrates.
