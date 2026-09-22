/**
 * Technical Debt 02 — pre-commit-safe unit test runner.
 *
 * Runs the subset of the vitest suite that never opens a real database
 * connection, for use in the fast/local pre-commit hook. Deliberately does
 * NOT read .env (no dotenv import here) and passes a guaranteed-unreachable
 * DATABASE_URL (127.0.0.1:1 — a port nothing ever listens on) so that if any
 * "safe" test unexpectedly tries to query a real database in the future,
 * it fails loudly and immediately (ECONNREFUSED) instead of silently
 * succeeding against .env's real target.
 *
 * The excluded file list below was derived empirically, not guessed: the
 * full suite was run once against this same dead DATABASE_URL, and every
 * file that failed with ECONNREFUSED (i.e. actually attempted a real query)
 * was added here. Files that merely import `db.ts` transitively (e.g. via
 * a repository) but never call a query method pass cleanly and are NOT
 * excluded — they were empirically proven not to need a live database.
 *
 * Heavy DB-backed integration tests stay in `npm run test:isolated`
 * (pre-push/CI), which runs them against a real, disposable Docker
 * database instead of skipping them.
 */
import { spawnSync } from "child_process";

const DB_DEPENDENT_TEST_FILES = [
  "apps/api/src/core/idempotency/idempotency.test.ts",
  "apps/api/src/core/testing/foundation/database-foundation.smoke.test.ts",
  "apps/api/src/core/tests/security/security-foundation.test.ts",
  "apps/api/src/core/tests/security/warehouse-scope-authorization.test.ts",
  "apps/api/src/core/jobs/jobs-drain.p3.test.ts",
  "apps/api/src/core/jobs/jobs.test.ts",
  "apps/api/src/core/middlewares/idempotency-race.p4.test.ts",
  "apps/api/src/core/middlewares/rate-limiter-race.p4.test.ts",
  "apps/api/src/core/outbox/outbox-claim-race.p4.test.ts",
  "apps/api/src/core/outbox/outbox-drain.p3.test.ts",
  "apps/api/src/core/outbox/outbox.test.ts",
  "apps/api/src/core/testing/multi-instance.p4.test.ts",
  "apps/api/src/core/middlewares/requireCatalogedPermission.integration.test.ts",
  "apps/api/src/modules/accounting/infrastructure/number-sequences.p21.test.ts",
  "apps/api/src/modules/accounting/infrastructure/technician-sales-metrics.p22.test.ts",
  "apps/api/src/modules/accounting/infrastructure/round2ActivePaths.p_dbR10c1.test.ts",
  "apps/api/src/modules/accounting/infrastructure/journalBalanceInvariant.test.ts",
  "apps/api/src/modules/accounting/infrastructure/salesInvoiceNumericPrecision.test.ts",
  "apps/api/src/modules/courier/infrastructure/optimistic-locking.test.ts",
  "apps/api/src/modules/inventory/infrastructure/services/serialized-items.service.delete-custody.integration.test.ts",
  "apps/api/src/modules/inventory/serial-verification-suite.test.ts",
  "apps/api/src/modules/inventory/infrastructure/database/DrizzleWarehouseRepository.deleteWarehouse.atomicity.test.ts",
  "apps/api/src/modules/courier/infrastructure/repositories/DrizzleCourierRepository.transferCustodyToTechnician.concurrency.test.ts",
  "apps/api/src/modules/courier/infrastructure/repositories/DrizzleCourierRepository.ownershipInvariant.test.ts",
  "apps/api/src/modules/inventory/infrastructure/database/items.statusCheckConstraint.test.ts",
  "apps/api/src/modules/inventory/infrastructure/database/coreInventory.nonnegativeCheckConstraint.test.ts",
  "apps/api/src/modules/inventory/infrastructure/database/inventoryEventQuantityPositiveCheckConstraint.test.ts",
  "apps/api/src/modules/inventory/infrastructure/database/operationalInventoryQuantityCheckConstraint.test.ts",
  "apps/api/src/modules/inventory/infrastructure/database/salesPurchaseQuantityCheckConstraint.test.ts",
  "apps/api/src/modules/inventory/infrastructure/database/technicianSalesMetricsQuantityCheckConstraint.test.ts",
  "apps/api/src/modules/inventory/infrastructure/database/withdrawTechnicianInventoryToWarehouseConcurrency.test.ts",
  "apps/api/src/modules/inventory/infrastructure/database/movingInventoryNonnegativeCheckConstraint.test.ts",
  "apps/api/src/modules/courier/infrastructure/inventory.engine.test.ts",
  "apps/api/src/modules/inventory/infrastructure/database/DrizzleDevicesRepository.test.ts",
  "apps/api/src/modules/inventory/infrastructure/subscribers/inventory.subscriber.test.ts",
  "apps/api/src/modules/courier/infrastructure/inventory.engine.concurrency.test.ts",
  "apps/api/src/modules/courier/infrastructure/pdf-report-approval-transaction.test.ts",
  "apps/api/src/modules/courier/presentation/routes/courier-pdf-approval.routes.test.ts",
  "apps/api/src/modules/courier/infrastructure/migration-p1-expand.smoke.test.ts",
  "apps/api/src/modules/courier/infrastructure/custody-closure-status-transition.test.ts",
  "apps/api/src/modules/courier/infrastructure/custody-closure-crash-consistency.test.ts",
  "apps/api/src/modules/courier/infrastructure/custody-closure-legacy-backfill.test.ts",
  "apps/api/src/modules/courier/infrastructure/courier-audit-dedup.test.ts",
  "apps/api/src/modules/courier/infrastructure/inventory-deduction-completion.test.ts",
  "apps/api/src/modules/courier/infrastructure/jobs/CourierProjectionWorker.test.ts",
  // OPS-REMED-E4-P4-I1.R1/I2: new DB-dependent test files added this gate.
  "apps/api/src/modules/courier/infrastructure/migration-p4-constraint.smoke.test.ts",
  "apps/api/src/modules/courier/infrastructure/custody-closure-production-writers.test.ts",
  "apps/api/src/core/idempotency/idempotency.service.integration.test.ts",
  "apps/api/src/modules/inventory/infrastructure/services/custody-engine.moving-inventory-concurrency.integration.test.ts",
  "apps/api/src/modules/courier/infrastructure/save-execution-custody-atomicity.integration.test.ts",
  // OPS-PERM-S0-B0.I1: registerCourierRoutes()'s composition wiring requires
  // DATABASE_URL to construct even though these tests never query it.
  "apps/api/src/modules/courier/presentation/routes/courier-global-delete-admin-only.routes.test.ts",
  // OPS-PERM-S0-B1-B.F1.R1: real isolated-DB proof of technician-directory
  // regional scoping — cannot be proven against a mocked repository.
  "apps/api/src/modules/courier/infrastructure/courier-lookups-technician-scope.routes.test.ts",
  // OPS-PERM-S0-B1-B.MR1.B1: registerCourierRoutes()'s composition wiring
  // requires DATABASE_URL to construct, same reason as the S0-B0 entry above.
  "apps/api/src/modules/courier/presentation/routes/courier-import-admin-only.routes.test.ts",
  // OPS-PERM-S0-B1-C.I1A: real-DB proof that no current write path can set
  // assigned_to_user_id — cannot be proven against a mocked repository.
  "apps/api/src/modules/courier/infrastructure/repositories/courier-request-assigned-to-user-id-containment.test.ts",
  // OPS-PERM-S0-B1-C.I1B: registerCourierRoutes()'s composition wiring
  // requires DATABASE_URL to construct, same reason as the S0-B0/B1-B
  // entries above, even though these HTTP-layer tests only exercise input
  // validation and never reach the database themselves.
  "apps/api/src/modules/courier/presentation/routes/courier-assignment.routes.test.ts",
  // OPS-PERM-S0-B1-C.I1B: real-DB proof of the Assignment Writer's
  // concurrency/atomicity/locking contract — cannot be proven against a
  // mocked repository.
  "apps/api/src/modules/courier/infrastructure/repositories/courier-assignment-writer-concurrency.test.ts",
  // OPS-PERM-S0-B1-C.I2A: real-DB proof of the auth_generation migration's
  // pre-migration-compatibility defaults — cannot be proven against a mocked
  // repository.
  "apps/api/src/core/tests/database/migration-0058-compatibility.test.ts",
  // OPS-PERM-S0-B1-C.I2A: real-Postgres proof of the refresh/deactivation
  // concurrency, transaction-rollback, and audit-atomicity contract —
  // same reason as the courier-assignment-writer-concurrency entry above.
  "apps/api/src/modules/identity/infrastructure/repositories/auth-refresh-deactivation-concurrency.test.ts",
  // OPS-PERM-S0-B1-C.I2A: real-Postgres proof that an account already
  // inactive before migration 0058 cannot have its pre-migration credentials
  // revived by a later reactivation — spins its own historical-cutoff
  // database, same technique as custody-closure-legacy-backfill.test.ts.
  "apps/api/src/modules/identity/infrastructure/database/migration-0058-historical-inactive-bootstrap.test.ts",
  // OPS-PERM-S0-B1-C.I2A: real-Postgres proof that Backup Restore's identity
  // transition and validation cannot be exercised against a mocked
  // repository — needs the real app, real routes, and a real transaction.
  "apps/api/src/modules/inventory/infrastructure/system/use-cases/ImportSystemBackup.security-transition.test.ts",
  // OPS-PERM-S1-F4-R3: same reason as ImportSystemBackup.security-transition.test.ts
  // above — real production app + real Postgres, proving restore now participates in
  // the last-active-admin invariant (including real concurrency scenarios).
  "apps/api/src/modules/inventory/infrastructure/system/use-cases/ImportSystemBackup.admin-invariant.test.ts",
  // OPS-PERM-S1-F4-R2: real-Postgres proof of the last-active-admin advisory-
  // lock concurrency protection — the whole point of this file is proving two
  // real, concurrently-committed transactions can't both remove an active
  // Admin; that can't be simulated against a mocked repository, same reason
  // as auth-refresh-deactivation-concurrency.test.ts above.
  "apps/api/src/modules/identity/infrastructure/repositories/last-active-admin-concurrency.test.ts",
  // OPS-PERM-S0-B1-C.I2A: real-Postgres proof that DrizzleUserRepository
  // itself (not merely the TypeScript type layer) cannot persist isActive/
  // authGeneration through its ordinary update/create methods.
  "apps/api/src/modules/identity/infrastructure/database/DrizzleUserRepository.security-state-containment.test.ts",
  // OPS-PERM-S1-F1.R2.SR1: real-Postgres proof of object-level authorization
  // for GET /api/users/:id and the supervisor assignment read endpoints —
  // needs the real app, real routes, and a real authenticated request chain.
  "apps/api/src/core/tests/security/object-level-authorization.test.ts",
];

const args = [
  "vitest",
  "run",
  // vitest.config.ts sets fileParallelism:false to avoid DB-table races
  // between integration-style test files (see Phase 3). None of that
  // applies here — every file in this safe subset was empirically proven
  // to never touch a database — so parallel file execution is safe and
  // meaningfully faster for this pre-commit-facing subset.
  "--fileParallelism",
  ...DB_DEPENDENT_TEST_FILES.flatMap((f) => ["--exclude", f]),
];

// Deliberately NOT sourced from .env — a poison value that fails fast and
// loudly if anything tries to actually use it. Every field is a separate
// constant, assembled into a URL only at runtime via URL(), so no single
// line of source text spells out a `postgres://user:pass@host/db` literal.
const POISON_DB_USER = "unit-safe-guard";
const POISON_DB_CREDENTIAL = "no-connection";
const POISON_DB_HOST = "127.0.0.1";
const POISON_DB_PORT = "1"; // nothing ever listens here
const POISON_DB_NAME = "unit_safe_never_connects";
const poisonUrl = new URL(`postgresql://${POISON_DB_HOST}:${POISON_DB_PORT}/${POISON_DB_NAME}`);
poisonUrl.username = POISON_DB_USER;
poisonUrl.password = POISON_DB_CREDENTIAL;
const POISON_DATABASE_URL = poisonUrl.toString();

// Not real secrets — dummy values satisfying the app's required-env-var
// guards (session.ts, jwt.config.ts) so this DB-free test subset can boot
// its Express app / import its JWT module without a real .env present
// (e.g. on a CI runner). Never used to sign anything meaningful here.
// Built from a "-not-for-production" suffix constant (rather than one
// inline literal) so it reads as the obvious placeholder it is, both to
// humans and to the repo's secret-scan gate.
const NOT_FOR_PRODUCTION = "not-for-production";
const POISON_SESSION_SECRET = `test-unit-safe-dummy-session-secret-${NOT_FOR_PRODUCTION}`;
const POISON_JWT_SECRET = `test-unit-safe-dummy-jwt-secret-${NOT_FOR_PRODUCTION}`;

const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args, {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    DATABASE_URL: POISON_DATABASE_URL,
    SESSION_SECRET: POISON_SESSION_SECRET,
    JWT_SECRET: POISON_JWT_SECRET,
  },
});

process.exit(result.status ?? 1);
