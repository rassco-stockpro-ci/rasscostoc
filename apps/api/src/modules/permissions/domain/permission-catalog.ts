/**
 * OPS-PERM-S1-F4 — canonical permission catalog.
 *
 * The frozen contract (OPS-PERM-S1-F3) requires "do not design around raw
 * free-text permission strings" and "only use scope types supported by actual
 * domain behavior". This file is the single source of truth for both: every
 * grantable (page, action) pair, what each role gets by default, and the hard
 * ceiling no override can ever cross — modeled on real, already-shipped
 * domain concepts (courier requests carry a region since migration 0055/0056;
 * warehouses carry a region; supervisor_warehouses is the existing relation
 * table) rather than invented ones.
 *
 * V1 SCOPE (OPS-PERM-S1-F4 §8 "V1 TARGET: Admin manages SUPERVISOR
 * permissions"): this catalog only models the pages/actions relevant to that
 * target. It intentionally does NOT attempt to re-express technician's
 * existing, regression-sensitive authorization through this system — see
 * DEFAULT_ROLE_TEMPLATE.technician's own comment — and it intentionally does
 * NOT include any accounting.* page: Accounting stays governed entirely by
 * its own isolated, already-proven default-deny policy
 * (accounting-default-deny.routes.test.ts), never by this catalog.
 */
import type { ActorRole, DataScope, PermissionKey } from "./types";

/** Every (page, action) pair the Permission Engine knows how to grant. A permission not listed
 * here can never be allowed — the evaluator treats an unknown page/action as `no-grant`, not as
 * an error, so an unrecognized permission fails closed exactly like a recognized-but-ungranted one. */
export const PERMISSION_CATALOG: readonly PermissionKey[] = [
  { page: "courier.requests", action: "view" },
  { page: "courier.requests", action: "create" },
  { page: "courier.requests", action: "update" },
  { page: "warehouse.inventory", action: "view" },
  { page: "warehouse.inventory", action: "update" },
  { page: "warehouse.transfers", action: "view" },
  { page: "warehouse.transfers", action: "create" },
  { page: "warehouse.transfers", action: "approve" },
  { page: "warehouse.transfers", action: "transfer" },
  { page: "reports.operational", action: "view" },
  // OPS-PERM-S2: newly cataloged. GET /api/system-logs previously had no role
  // restriction at all (any authenticated role, including technician/viewer,
  // could read the full audit log) — this closes that gap for supervisor via
  // the Permission Engine, and separately (at the route) restricts the page
  // to admin+supervisor only, matching its existing frontend nav visibility.
  { page: "system.auditLogs", action: "view" },
] as const;

function key(page: string, action: string): string {
  return `${page}:${action}`;
}

export const CATALOG_KEYS: ReadonlySet<string> = new Set(PERMISSION_CATALOG.map((p) => key(p.page, p.action)));

export function isCatalogedPermission(page: string, action: string): boolean {
  return CATALOG_KEYS.has(key(page, action));
}

/**
 * Hard role ceiling — OPS-PERM-S1-F3 §3 / OPS-PERM-S1-F4 §0. The maximum any default template
 * entry or admin override can ever reach for that role, and the DataScope no grant for that role
 * may exceed. Admin is handled specially in the evaluator (system-wide, not enumerated here) so
 * that adding a new catalog page never silently needs an admin ceiling edit to keep working.
 *
 * Exact role keys only — never resolved through ROLE_ORDER/hasRoleOrAbove/isSupervisor(). That is
 * the specific, named reason courier_supervisor gets its own row instead of inheriting supervisor's.
 */
export const ROLE_HARD_CEILING: Readonly<Record<Exclude<ActorRole, "admin">, { grants: ReadonlySet<string>; scope: DataScope }>> = {
  supervisor: {
    grants: new Set([
      key("courier.requests", "view"),
      key("courier.requests", "create"),
      key("courier.requests", "update"),
      key("warehouse.inventory", "view"),
      key("warehouse.transfers", "view"),
      key("warehouse.transfers", "approve"),
      key("warehouse.transfers", "transfer"),
      key("reports.operational", "view"),
      key("system.auditLogs", "view"),
    ]),
    scope: "REGION",
  },
  // Legacy courier-module compatibility role. Deliberately its own, narrower ceiling — see
  // OPS-PERM-S1-F3 §3's ROLE_ORDER finding. Never a superset or subset relationship with
  // supervisor's row is assumed anywhere in the evaluator; the two are unrelated sets.
  courier_supervisor: {
    grants: new Set([key("courier.requests", "view"), key("courier.requests", "update")]),
    scope: "REGION",
  },
  warehouse: {
    grants: new Set([key("warehouse.inventory", "view"), key("warehouse.inventory", "update"), key("warehouse.transfers", "view")]),
    scope: "WAREHOUSE",
  },
  // Technician's real authorization stays entirely on its existing, regression-sensitive
  // production path (own-custody, own-tasks — see warehouse-scope.policy.ts's technician-own
  // contract and the courier module's own assignment checks). This ceiling exists only so the
  // evaluator has a defined, safe answer — deny everything not SELF — if it is ever asked about a
  // technician; it is not, and must not become, technician's actual authorization mechanism.
  technician: { grants: new Set(), scope: "SELF" },
  viewer: { grants: new Set(), scope: "SELF" },
} as const;

/**
 * Default role template — OPS-PERM-S1-F3 §0/§4. What a role gets with zero admin intervention.
 * Deliberately narrower than the hard ceiling for supervisor: the gap between this and the
 * ceiling above is exactly what an admin can grant through the Permissions Center (e.g. Reports,
 * transfer approval) without ever exceeding it.
 *
 * No region is stored here — "the template must NOT store a specific region as a permission
 * grant" (OPS-PERM-S1-F4 §4). The evaluator resolves the actor's actual region at request time.
 */
export const DEFAULT_ROLE_TEMPLATE: Readonly<Record<Exclude<ActorRole, "admin">, ReadonlySet<string>>> = {
  supervisor: new Set([
    key("courier.requests", "view"),
    key("courier.requests", "update"),
    key("warehouse.inventory", "view"),
    key("warehouse.transfers", "view"),
    // OPS-PERM-S2: in the default template (not just the ceiling) because every
    // existing supervisor already has de facto access today (GET /api/system-logs
    // was requireAuth-only) — putting it here keeps enforcement a no-op for
    // existing accounts rather than requiring a backfill for this one.
    key("system.auditLogs", "view"),
  ]),
  courier_supervisor: new Set([key("courier.requests", "view"), key("courier.requests", "update")]),
  warehouse: new Set([key("warehouse.inventory", "view"), key("warehouse.inventory", "update"), key("warehouse.transfers", "view")]),
  technician: new Set(),
  viewer: new Set(),
} as const;

export function permissionKeyString(page: string, action: string): string {
  return key(page, action);
}
