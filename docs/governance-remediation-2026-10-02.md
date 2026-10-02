# Courier close & release governance (remediation 2026-10-02)

Status of each decision, the rule it produced, where it is enforced and what
proves it. Multi-Device / Multi-SIM work starts from this baseline.

## 1. Release model: source → CI → build → artifact → runtime

| Step | Rule | Enforced by |
|---|---|---|
| Source | A release is built from a clean commit. | `npm run build:release` (`RELEASE_REQUIRE_CLEAN=1`): `scripts/write-release-sha.cjs` refuses a dirty tree. |
| Identity | `dist/RELEASE_SHA` is the commit SHA only for a clean tree; a dirty build is labelled `<sha>-dirty`. `dist/RELEASE_MANIFEST.json` records source SHA, dirty flag + fingerprint of the uncommitted changes, Node/npm, lockfile hash, build time. | `write-release-sha.cjs`; `scripts/lib/release-sha-check.sh` rejects `-dirty` (exit 4), so `pre-deploy-guard.sh` never deploys it. |
| Node | Exactly the version in `.nvmrc` (24.18.0, the production runtime). | `scripts/check-node-version.cjs` (first build step); CI `setup-node` uses `node-version-file: .nvmrc`; `engines.node`. |
| Clean output | `dist/` and the workspace package outputs (`packages/ai-extraction/dist`, its `tsbuildinfo`) are emptied before every build. Refused while a process runs that `dist/server.js`. | `scripts/clean-dist.cjs`. |
| Runtime deps | Every package the bundle loads is a declared, non-dev dependency in the lockfile; dev-only packages (vite chain) are only reachable through a dynamic import taken in development; workspace packages it loads are built. | `scripts/verify-runtime-deps.cjs` (reads `dist/meta.json` + `package-lock.json`). |
| Lockfile | Authoritative: CI and deploy install with `npm ci`. | CI jobs; `scripts/atomic-deploy.sh` step 6. |

### Reproducible build procedure

```
git checkout <release commit>          # clean tree
nvm use                                # .nvmrc -> 24.18.0
npm ci                                 # dev deps are needed to build
npm run build:release                  # check-node -> clean -> build:packages -> vite -> esbuild
                                       # -> verify-runtime-deps -> write-release-sha (clean only)
```

### Runtime dependency installation (release directory, never the live one)

```
tar -xzf <artifact>  -C releases/<BUILD_ID>    # dist/, packages/*/dist, package.json, package-lock.json,
                                               # workspace package.json files
cd releases/<BUILD_ID> && npm ci --omit=dev    # lockfile only; native modules build here (bcrypt)
```

Proven on 2026-10-02: a `npm ci --omit=dev` install plus this build loads the
whole bundle with zero missing modules (startup stops only at the database
connection of the test environment).

Not yet in place (deploy task, out of scope here): `scripts/build-and-package.sh`
referenced by `atomic-deploy.sh` does not exist; production still runs from the
live working tree (`/home/nuzum/htdocs/nuzum.fun/dist`), not from `releases/`.

## 2. Domain decisions (product owner, 2026-10-02)

1. **Active custody** — `IN_TRANSIT` (task started, item on the way to the
   customer) is active custody, with `IN_TRANSIT_CUSTODY` and
   `RECEIVED_BY_TECHNICIAN`. Single definition:
   `modules/inventory/domain/active-custody.policy.ts`, exported to other
   modules via `modules/inventory/contracts/custody-policy.ts`. Used by the
   close guards, the deduction scan-out, serial lookup, custody listings,
   deactivation and transfer checks.
2. **Close** — a successful close moves the request items it installs
   `RECEIVED → INSTALLED` on every channel; other items keep their status.
3. **Reserved** — `DELIVERED`, `REJECTED`, `MISSING` have no transitions.
4. **Receiving** — accepts `RECEIVED` only, for items of the same request.
5. **Node** — 24 (pinned 24.18.0).

## 3. Request item state machine

Source of truth: `modules/courier/domain/request-item.state-machine.ts`.

| From | Action | To | Actor / channel |
|---|---|---|---|
| (new) | ASSIGN | PENDING_RECEIPT | dispatcher (portal assign) · technician (mobile accept) |
| (new) | BIND_AT_CLOSE | RECEIVED | closing user (portal close, PDF approve/apply), custody-validated serial not yet linked |
| PENDING_RECEIPT | RECEIVE | RECEIVED | technician (mobile scan / confirm-receiving); implied at close for a linked serial whose custody the guard validated |
| RECEIVED | RECEIVE | RECEIVED | idempotent re-receive |
| RECEIVED | INSTALL | INSTALLED | successful close, all channels, close items only |

Bot and outbox worker write no item state. Re-assignment may only replace items
still `PENDING_RECEIPT`. Violations: 422 `REQUEST_ITEM_TRANSITION_INVALID` /
`REQUEST_ITEM_NOT_IN_REQUEST`.

### Database constraints — designed, NOT applied

Order: domain decision ✔ → application enforcement ✔ → tests ✔ → migration
(this design) → database certification.

* `courier_request_items_status_check`: `CHECK (status IN ('PENDING_RECEIPT','RECEIVED','INSTALLED','DELIVERED','REJECTED','MISSING'))`
  added `NOT VALID`, then `VALIDATE` in a second migration (same pattern as
  0029/0030). Backward compatible: production holds only `RECEIVED` (14 rows,
  2026-10-02). Rollback: `DROP CONSTRAINT`.
* Serial uniqueness: a partial unique index on the serial of items in
  `PENDING_RECEIPT`/`RECEIVED` needs a domain decision first (may one serial be
  pending on two requests?). Production has 0 duplicates today.
* Device↔SIM relation: part of the Multi-Device design, not this stage.

## 4. Close transaction (CloseRequestUseCase)

`modules/courier/application/close/close-request.use-case.ts` owns what every
close commits. `plan()` runs the read phase before the transaction; `commit()`
runs inside it: bind → INSTALL → deduct (devices, SIMs, consumables,
completion row) → `CLOSED_SUCCESS` → audit → `ExecutionCompletedEvent` on the
transactional outbox. Any failure rolls the whole close back.

Transaction contract (`modules/courier/domain/transaction.ts`): the unit of
work hands the application an opaque `inventoryTransaction` handle and a
`TransactionalOutbox` bound to the same transaction. Only
`DrizzleCourierUnitOfWork` turns the Drizzle transaction into them.

## 5. Consumables quantity rule

`resolveConsumableQuantities(input, stored)` in
`modules/courier/application/inventory/consumables.ts` — the guard, the close
deduction and the legacy subscriber all call it. Submitted value, else stored
value, else 0; empty (null/"") = legacy flag (`paperRoll` "Yes" → 1 roll);
non-negative integer = that value; anything else = 422
`CONSUMABLE_QUANTITY_INVALID`.

## 6. Outbox processing lease

`OUTBOX_LEASE_MS` (5 min). Claimable: `PENDING`, due `FAILED`, and `PROCESSING`
whose lease expired (worker died). Recovering an expired lease counts as an
attempt; at `MAX_ATTEMPTS` (3) the event is dead-lettered instead of
dispatched. `markAsPublished/Failed/Dead` are fenced to the lease owner.
Logical exactly-once comes from the completion row + subscriber idempotency.

## 7. Legacy deduction path (InventorySubscriber)

Proven producers of `ExecutionCompletedEvent` (2026-10-02):
`CloseRequestUseCase.commit` only — it writes the completion row in the same
transaction, so the subscriber acknowledges without deducting.
`CourierWorkflow.handleInventoryDeduction` has no production caller.
Production outbox: 0 pending/failed `ExecutionCompletedEvent`.

Compatibility mode: an event without a completion row is deducted from its own
execution snapshot only (never rebuilt from request items) and logged as
`LEGACY deduction`.

Retirement plan: (1) deploy; (2) one release with zero `LEGACY deduction` log
lines and zero pending events → (3) remove the deduction branch (acknowledge
only) → (4) remove the subscription.

## 8. Dead code (reported, not removed)

| Code | Callers | Reason it exists | Replacement | Removal |
|---|---|---|---|---|
| `CourierWorkflow.execute` / `handleInventoryDeduction` | tests only (`courier.workflow.test.ts`) | pre-hardening post-commit deduction trigger | `CloseRequestUseCase` | separate cleanup: keep `decide()`, delete `execute`/`handleInventoryDeduction` and their tests together |
| `InventoryEngine.resolveTechnician` | none | legacy preference-based resolution | `resolveAndValidateTechnician` | delete with a unit test proving no caller |
| `shared/utils/vite.ts` | none | transitional wrapper | `core/utils/vite` (dev) / `core/utils/static` | delete |
| `ICourierTransactionPort` | none | earlier transaction abstraction | `ICourierUnitOfWork` + `domain/transaction.ts` | delete |

## 9. Remaining dependency-inversion work (incremental)

Still concrete in the application layer: `EventBus.getInstance()` for
`ExecutionSavedEvent` (uses `ctx.tx`), `SerialRecognitionService` static calls.
Next step: route `ExecutionSavedEvent` through `ctx.outbox`, and inject a
serial-resolution port.
