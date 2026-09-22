/**
 * OPS-PERM-S1-F5 — Permissions Center UI: response types and label lookups.
 *
 * These types mirror the frozen OPS-PERM-S1-F4 backend contract
 * (apps/api/src/modules/permissions/{domain/types.ts,application/PermissionsService.ts,
 * domain/repositories/IPermissionsRepository.ts}) rather than importing it — apps/portal is a
 * separate deployable frontend and never imports apps/api internals. Keep this file's shapes in
 * sync with that module if the backend contract ever changes.
 *
 * V1 SCOPE (unchanged from F4): the Permissions Center only manages employees whose role is
 * "supervisor" — see PermissionsService's own "Admin manages SUPERVISOR permissions" comment.
 */
import { UserCog, type LucideIcon } from "lucide-react";
import { navigationRegistry } from "@/lib/navigation";
import { ROLES } from "@shared/roles";

/** Matches LanguageContextType["t"] from src/i18n/provider.tsx without importing React context
 * plumbing into this plain-data module. */
export type TFunction = (key: string, options?: { ar?: string; en?: string } & Record<string, any>) => string;

export type OverrideValue = "grant" | "revoke";
export type DataScope = "GLOBAL" | "REGION" | "WAREHOUSE" | "RELATION" | "SELF";
export type GrantSource = "admin" | "role-template" | "override";
export type DenyReason =
  | "actor-inactive"
  | "unknown-role"
  | "role-ceiling"
  | "no-grant"
  | "explicit-deny"
  | "scope-unresolved"
  | "scope-mismatch"
  | "actor-region-missing"
  | "resource-region-missing"
  | "not-own-resource";

export type PermissionDecision =
  | { allowed: true; reason: GrantSource; scope: DataScope }
  | { allowed: false; reason: DenyReason };

export interface EmployeePermissionRow {
  page: string;
  action: string;
  defaultGrant: boolean;
  assigned: OverrideValue | null;
  effective: PermissionDecision;
}

export interface EmployeePermissionSnapshot {
  userId: string;
  role: string;
  isActive: boolean;
  regionId: string | null;
  hardCeilingScope: string | null;
  permissions: EmployeePermissionRow[];
}

export interface PermissionChangeAuditEntry {
  id: string;
  changedBy: string;
  targetUserId: string;
  page: string;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  changedAt: string;
}

export interface WriteOverrideResult {
  success: boolean;
  override?: {
    id: string;
    userId: string;
    page: string;
    action: string;
    value: OverrideValue;
    grantedBy: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  } | null;
}

/** A row is off-limits for this admin panel exactly when the evaluator's effective decision says
 * so via "role-ceiling" — never re-derived from a locally duplicated ceiling set, so this stays
 * correct even if the backend catalog/ceiling changes without a matching frontend edit. */
export function isRowEditable(row: EmployeePermissionRow): boolean {
  return !(row.effective.allowed === false && row.effective.reason === "role-ceiling");
}

/** i18n key segment for a catalog page string — the locale JSON stores nested keys with
 * underscores (e.g. "courier_requests"), never a literal "." (the i18n lookup path splits on
 * every dot, so a dotted key like "courier.requests" could never be addressed as one segment). */
function pageKeySegment(page: string): string {
  return page.replace(/\./g, "_");
}

export function pageLabel(t: TFunction, page: string): string {
  const key = `permissions_center.pages.${pageKeySegment(page)}`;
  const label = t(key);
  return label === key ? page : label;
}

/** Optional, purely presentational one-liner for a catalog page — empty string when the locale
 * has none, so callers never render a raw i18n key as if it were content. */
export function pageDescription(t: TFunction, page: string): string {
  const key = `permissions_center.pages_desc.${pageKeySegment(page)}`;
  const label = t(key);
  return label === key ? "" : label;
}

export function actionLabel(t: TFunction, action: string): string {
  const key = `permissions_center.actions.${action}`;
  const label = t(key);
  return label === key ? action : label;
}

export function permissionLabel(t: TFunction, page: string, action: string): string {
  return `${pageLabel(t, page)} · ${actionLabel(t, action)}`;
}

export function grantSourceLabel(t: TFunction, source: GrantSource): string {
  return t(`permissions_center.sources.${source}`);
}

export function denyReasonLabel(t: TFunction, reason: DenyReason): string {
  return t(`permissions_center.reasons.${reason}`);
}

export function dataScopeLabel(t: TFunction, scope: DataScope): string {
  return t(`permissions_center.scopes.${scope}`);
}

export function overrideValueLabel(t: TFunction, value: OverrideValue | null): string {
  return t(`permissions_center.override_values.${value ?? "reset"}`);
}

export interface RealUncatalogedPage {
  id: string;
  labelKey: string;
  /** Real route, when the page has one reachable via the top-nav sidebar — undefined for
   * in-app-only pages (e.g. reached via a link from another page rather than the nav). */
  href?: string;
  /** The exact icon StockPro's own sidebar already uses for this page (navigationRegistry's own
   * `icon`) — never a generic shared lock/link glyph repeated across unrelated pages
   * (OPS-PERM-S1-F5 §22: one coherent icon family, mapped per real page, no parallel icon set). */
  icon: LucideIcon;
}

/** Nav ids covered by an actual catalog page today — "warehouses" because warehouse.inventory /
 * warehouse.transfers already govern it; "courier" is a real cataloged capability
 * (courier.requests) but is not treated as "locked" here because its own route is itself hard
 * role-gated to admin-only in App.tsx — a Supervisor can never reach /courier through navigation
 * regardless of any grant, a distinct gap reported separately from "not governed". "logs" because
 * system.auditLogs:view now governs it (OPS-PERM-S2) — GET /api/system-logs is no longer
 * requireAuth-only; it is restricted to admin+supervisor and, for supervisor, gated through the
 * Permission Engine. */
const CATALOG_GOVERNED_NAV_IDS = new Set(["warehouses", "courier", "logs"]);

/** Nav ids with a PROVEN, isolated, admin-only backend policy — never governed by this Permission
 * Engine and never intended to be: accounting's admin-only default-deny is enforced independently
 * at its own route layer (apps/api/src/modules/accounting/presentation/routes/
 * accounting-default-deny.routes.test.ts — 30 certified accounting routes, checked against every
 * non-admin role including supervisor), not by PERMISSION_CATALOG. This is the ONLY id in this
 * set — no other real Supervisor-visible page has an equivalent proven isolation policy today, so
 * no other page may be presented this way (OPS-PERM-S1-F5 §9/§10: "ADMIN-ONLY ≠ NOT YET GOVERNED",
 * asserted only where backend policy actually proves it). */
const PROVEN_ADMIN_ONLY_NAV_IDS = new Set(["accounting"]);

/** Real, Supervisor-visible pages with a PROVEN isolated admin-only backend policy (currently just
 * Accounting — see PROVEN_ADMIN_ONLY_NAV_IDS). Rendered with a distinct "system-reserved" locked
 * treatment, never a Grant control, and never conflated with a merely not-yet-governed page. */
export function adminOnlyPages(): RealUncatalogedPage[] {
  return navigationRegistry
    .filter((item) => item.roles.includes(ROLES.SUPERVISOR) && PROVEN_ADMIN_ONLY_NAV_IDS.has(item.id))
    .map((item) => ({ id: item.id, labelKey: item.labelKey, href: item.href, icon: item.icon }));
}

/** Real StockPro nav routes the Supervisor role can actually see (per navigationRegistry's own
 * `roles`) that this Permission Engine's catalog does not govern at the page/action level yet, and
 * that have no proven admin-only isolation either — access to these is decided by role alone,
 * today, for lack of a canonical (page, action) entry (a real product-scope gap, not a design
 * choice — see the F5 backend-contract-gap report).
 *
 * Also includes real routes reachable via in-app links rather than the top-nav sidebar — verified
 * directly against App.tsx's route table, never invented: "/technician-details/:id" and its
 * "/technician-details/:technicianId/item/:itemTypeId" child, StockPro's real "بيانات الفنيين" /
 * "مخزون فني محدد" pages, registered outside every role gate in App.tsx (reachable by any
 * authenticated role today — a separate, pre-existing observation, not something this file changes).
 *
 * Listed transparently, never hidden (OPS-PERM-S1-F5 visual remediation §9) — this function never
 * fabricates a grantable permission for these; the UI must only ever present them locked. */
export function ungovernedPages(): RealUncatalogedPage[] {
  const fromRegistry = navigationRegistry
    .filter(
      (item) =>
        item.roles.includes(ROLES.SUPERVISOR) &&
        !CATALOG_GOVERNED_NAV_IDS.has(item.id) &&
        !PROVEN_ADMIN_ONLY_NAV_IDS.has(item.id)
    )
    .map((item) => ({ id: item.id, labelKey: item.labelKey, href: item.href, icon: item.icon }));
  const inAppOnly: RealUncatalogedPage[] = [
    // Real, but not in navigationRegistry (reached via an in-app link, not the sidebar) — its own
    // dedicated icon (StockPro has no sidebar entry to borrow one from), matching the "technician"
    // mapping already used elsewhere in the app (employee-detailed-profile-template etc.).
    { id: "technician-details", labelKey: "permissions_center.extra_pages.technician_details", icon: UserCog },
  ];
  return [...fromRegistry, ...inAppOnly];
}
