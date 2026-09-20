/**
 * OPS-PERM-S1-F5 — Permissions Center UI: the per-employee detail panel.
 *
 * Reads/writes exclusively through the frozen OPS-PERM-S1-F4 backend API
 * (GET/POST /api/admin/permissions/employees/:userId/*). Every write is re-validated
 * server-side (self-edit, target role, hard ceiling, optimistic concurrency) — this panel's own
 * "not available for this role" styling is a UX convenience derived from the snapshot's own
 * effective decisions (see isRowEditable), never the authority.
 *
 * OPS-PERM-S1-F5 structural rebuild — matches the accepted mockup
 * (a_clean_modern_web_app_dashboard_ui_screenshot_ar_1.png) in structure: one merged
 * context+KPI strip (SupervisorIdentity + ContextField ×3 + PermissionSummary), three tabs, a
 * status-filter toolbar, and a governed-page CARD GRID that stays compact by default — each card
 * shows real capability chips + default/denied/allowed mini-stats; selecting a chip reveals
 * SelectedActionDetail for that one action only (never every action's controls permanently
 * expanded). Two DISTINCT locked card grids — "صفحات غير مرتبطة بمحرك الصلاحيات" (real pages with
 * no canonical permission yet, each with its own real semantic icon from the nav registry) and
 * "صفحات إدارية محظورة" (pages with a proven, independent, admin-only backend policy — currently
 * only Accounting). ADMIN-ONLY is never used as a synonym for NOT-YET-GOVERNED — see
 * lib/permissions-center.ts's adminOnlyPages()/ungovernedPages() for the evidence behind that
 * split. Neither grid ever renders a Grant/Revoke control.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Boxes,
  ChevronDown,
  FileText,
  History,
  Loader2,
  Lock,
  MapPin,
  Search,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  SlidersHorizontal,
  Truck,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "@/lib/language";
import { apiRequest } from "@/lib/queryClient";
import { getRoleLabel } from "@shared/roles";
import type { RegionWithStats, UserSafe } from "@shared/schema";
import {
  actionLabel,
  adminOnlyPages,
  dataScopeLabel,
  denyReasonLabel,
  grantSourceLabel,
  isRowEditable,
  overrideValueLabel,
  pageDescription,
  pageLabel,
  permissionLabel,
  ungovernedPages,
  type DataScope,
  type EmployeePermissionRow,
  type EmployeePermissionSnapshot,
  type OverrideValue,
  type PermissionChangeAuditEntry,
  type RealUncatalogedPage,
  type WriteOverrideResult,
} from "@/lib/permissions-center";

type WriteType = "grant" | "revoke" | "reset";
type PendingWrite = { type: WriteType; row: EmployeePermissionRow } | null;
type PageFilterMode = "all" | "allowed" | "denied" | "overridden" | "locked";

/** Real catalog page → a meaningful existing icon (lucide-react, already used elsewhere in
 * StockPro — no new icon framework). Falls back to a generic file icon for any future catalog
 * page this mapping hasn't been extended for yet, never a broken/missing glyph. */
function pageIcon(page: string): LucideIcon {
  switch (page) {
    case "courier.requests":
      return Truck;
    case "warehouse.inventory":
      return Boxes;
    case "warehouse.transfers":
      return ArrowLeftRight;
    case "reports.operational":
      return BarChart3;
    default:
      return FileText;
  }
}

interface EmployeePermissionsPanelProps {
  employee: UserSafe;
  usersById: Map<string, UserSafe>;
  regionsById: Map<string, RegionWithStats>;
  onChangeSupervisor: () => void;
}

export function EmployeePermissionsPanel({ employee, usersById, regionsById, onChangeSupervisor }: EmployeePermissionsPanelProps) {
  const { t, dir } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const userId = employee.id;

  const snapshotQuery = useQuery<EmployeePermissionSnapshot>({
    queryKey: [`/api/admin/permissions/employees/${userId}`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/permissions/employees/${userId}`);
      return res.json();
    },
  });

  const auditQuery = useQuery<PermissionChangeAuditEntry[]>({
    queryKey: [`/api/admin/permissions/employees/${userId}/audit`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/permissions/employees/${userId}/audit`);
      return res.json();
    },
  });

  const [pendingWrite, setPendingWrite] = useState<PendingWrite>(null);
  const [reason, setReason] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filterMode, setFilterMode] = useState<PageFilterMode>("all");

  const writeMutation = useMutation({
    mutationFn: async (input: { type: WriteType; page: string; action: string; reason?: string }) => {
      const res = await apiRequest("POST", `/api/admin/permissions/employees/${userId}/${input.type}`, {
        page: input.page,
        action: input.action,
        reason: input.reason,
      });
      return (await res.json()) as WriteOverrideResult;
    },
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/admin/permissions/employees/${userId}`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/admin/permissions/employees/${userId}/audit`] }),
      ]);
      const toastKey =
        variables.type === "grant" ? "grant_success" : variables.type === "revoke" ? "revoke_success" : "reset_success";
      toast({ title: t(`permissions_center.toast.${toastKey}`) });
      setPendingWrite(null);
      setReason("");
    },
    onError: (error: any) => {
      toast({
        title: t("permissions_center.toast.write_error"),
        description: error?.message || undefined,
        variant: "destructive",
      });
    },
  });

  const rowsByPage = useMemo(() => {
    const map = new Map<string, EmployeePermissionRow[]>();
    for (const row of snapshotQuery.data?.permissions ?? []) {
      const list = map.get(row.page) ?? [];
      list.push(row);
      map.set(row.page, list);
    }
    return map;
  }, [snapshotQuery.data]);

  // Static across renders (derived from the real navigation registry, not per-employee data) —
  // computed once rather than on every render. Two DISTINCT lists — see this file's header
  // comment on why ADMIN-ONLY must never be conflated with NOT-YET-GOVERNED.
  const ungoverned = useMemo(() => ungovernedPages(), []);
  const adminOnly = useMemo(() => adminOnlyPages(), []);

  // §15 filters — search + a single filter mode, applied to the 4 governed pages and the two
  // locked grids independently. Never filters individual actions out of a page card; a page
  // either matches (its chip row shown in full) or doesn't (hidden entirely), so the Admin never
  // sees a partially-truncated card that could be mistaken for the page's complete action set.
  const filteredGovernedPages = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const entries = Array.from(rowsByPage.entries());
    return entries.filter(([page, rows]) => {
      if (filterMode === "locked") return false;
      if (term && !pageLabel(t, page).toLowerCase().includes(term)) return false;
      if (filterMode === "allowed") return rows.some((r) => r.effective.allowed);
      if (filterMode === "denied") return rows.some((r) => !r.effective.allowed);
      if (filterMode === "overridden") return rows.some((r) => r.assigned !== null);
      return true;
    });
  }, [rowsByPage, searchTerm, filterMode, t]);

  const filterLockedList = (list: RealUncatalogedPage[]) => {
    if (filterMode === "allowed" || filterMode === "denied" || filterMode === "overridden") return [];
    const term = searchTerm.trim().toLowerCase();
    if (!term) return list;
    return list.filter((page) => t(page.labelKey).toLowerCase().includes(term));
  };
  const filteredUngoverned = useMemo(() => filterLockedList(ungoverned), [ungoverned, searchTerm, filterMode, t]);
  const filteredAdminOnly = useMemo(() => filterLockedList(adminOnly), [adminOnly, searchTerm, filterMode, t]);

  // Derived-only counts across the whole catalog — every number here is a plain filter over the
  // snapshot already fetched for the grid below, never a separately invented statistic. FROZEN
  // four-metric model (OPS-PERM-S1-F5): الافتراضية / الممنوحة يدويًا / المسحوبة يدويًا /
  // الصلاحيات الفعلية — never collapsed to fewer tiles for visual convenience.
  const summary = useMemo(() => {
    const rows = snapshotQuery.data?.permissions ?? [];
    return {
      total: rows.length,
      defaultCount: rows.filter((r) => r.defaultGrant).length,
      grantedCount: rows.filter((r) => r.assigned === "grant").length,
      revokedCount: rows.filter((r) => r.assigned === "revoke").length,
      effectiveCount: rows.filter((r) => r.effective.allowed).length,
    };
  }, [snapshotQuery.data]);

  const openConfirm = (type: WriteType, row: EmployeePermissionRow) => {
    setReason("");
    setPendingWrite({ type, row });
  };

  const closeDialog = (open: boolean) => {
    if (!open && !writeMutation.isPending) {
      setPendingWrite(null);
      setReason("");
    }
  };

  const confirmWrite = () => {
    if (!pendingWrite) return;
    writeMutation.mutate({
      type: pendingWrite.type,
      page: pendingWrite.row.page,
      action: pendingWrite.row.action,
      reason: reason.trim() || undefined,
    });
  };

  if (snapshotQuery.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl bg-white p-12 text-rassco-text shadow-sm min-h-[40vh]" dir={dir}>
        <Loader2Spin />
        <span>{t("permissions_center.loading_snapshot")}</span>
      </div>
    );
  }

  if (snapshotQuery.error || !snapshotQuery.data) {
    return (
      <div className="rounded-2xl bg-white p-8 text-center space-y-3 shadow-sm" dir={dir}>
        <p className="text-sm text-destructive">{(snapshotQuery.error as Error)?.message}</p>
        <Button variant="outline" onClick={() => snapshotQuery.refetch()}>
          {t("permissions_center.retry")}
        </Button>
      </div>
    );
  }

  const snapshot = snapshotQuery.data;
  const region = snapshot.regionId ? regionsById.get(snapshot.regionId) : undefined;
  const scopeLabel = snapshot.hardCeilingScope ? dataScopeLabel(t, snapshot.hardCeilingScope as DataScope) : "—";
  const dialogPermission = pendingWrite ? permissionLabel(t, pendingWrite.row.page, pendingWrite.row.action) : "";

  return (
    <div className="space-y-4" dir={dir}>
      <ContextStrip employee={employee} snapshot={snapshot} regionName={region?.name} summary={summary} onChangeSupervisor={onChangeSupervisor} />

      <Tabs defaultValue="access">
        <TabsList>
          <TabsTrigger value="access" data-testid="tab-access" className="text-sm font-semibold">
            <ShieldCheck className="h-4 w-4 me-1.5" />
            {t("permissions_center.tabs.access")}
          </TabsTrigger>
          <TabsTrigger value="scope" data-testid="tab-scope" className="text-sm font-semibold">
            <MapPin className="h-4 w-4 me-1.5" />
            {t("permissions_center.tabs.scope")}
          </TabsTrigger>
          <TabsTrigger value="audit" data-testid="tab-audit" className="text-sm font-semibold">
            <History className="h-4 w-4 me-1.5" />
            {t("permissions_center.tabs.audit")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="access" className="space-y-5">
          <PermissionsToolbar t={t} searchTerm={searchTerm} onSearchChange={setSearchTerm} filterMode={filterMode} onFilterChange={setFilterMode} />

          {filteredGovernedPages.length > 0 && (
            <div className="space-y-3">
              {filterMode === "all" && (
                <p className="text-sm font-bold text-rassco-text px-1">{t("permissions_center.page_access.governed_heading")}</p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 min-[1800px]:grid-cols-4 gap-4">
                {filteredGovernedPages.map(([page, rows]) => (
                  <GovernedPageCard
                    key={page}
                    t={t}
                    page={page}
                    rows={rows}
                    scopeLabel={scopeLabel}
                    disabled={writeMutation.isPending}
                    onGrant={(row) => openConfirm("grant", row)}
                    onRevoke={(row) => openConfirm("revoke", row)}
                    onReset={(row) => openConfirm("reset", row)}
                  />
                ))}
              </div>
            </div>
          )}

          {filteredUngoverned.length > 0 && (
            <LockedSection
              t={t}
              variant="ungoverned"
              heading={t("permissions_center.page_access.ungoverned_heading")}
              subtitle={t("permissions_center.page_access.ungoverned_subtitle")}
              pages={filteredUngoverned}
            />
          )}

          {filteredAdminOnly.length > 0 && (
            <LockedSection
              t={t}
              variant="admin-only"
              heading={t("permissions_center.page_access.admin_only_heading")}
              subtitle={t("permissions_center.page_access.admin_only_subtitle")}
              pages={filteredAdminOnly}
            />
          )}

          {filteredGovernedPages.length === 0 && filteredUngoverned.length === 0 && filteredAdminOnly.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-10">{t("permissions_center.page_access.no_matches")}</p>
          )}
        </TabsContent>

        <TabsContent value="scope">
          <DataScopeCard t={t} snapshot={snapshot} regionName={region?.name} />
        </TabsContent>

        <TabsContent value="audit">
          <AuditActivityList t={t} dir={dir} auditQuery={auditQuery} usersById={usersById} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={pendingWrite !== null} onOpenChange={closeDialog}>
        <AlertDialogContent dir={dir}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingWrite?.type === "grant" && t("permissions_center.confirm_dialog.grant_title")}
              {pendingWrite?.type === "revoke" && t("permissions_center.confirm_dialog.revoke_title")}
              {pendingWrite?.type === "reset" && t("permissions_center.confirm_dialog.reset_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingWrite?.type === "grant" &&
                t("permissions_center.confirm_dialog.grant_description", { permission: dialogPermission })}
              {pendingWrite?.type === "revoke" &&
                t("permissions_center.confirm_dialog.revoke_description", { permission: dialogPermission })}
              {pendingWrite?.type === "reset" &&
                t("permissions_center.confirm_dialog.reset_description", { permission: dialogPermission })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {pendingWrite && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-muted/40 p-3 text-sm">
              <ConfirmField label={t("permissions_center.confirm_dialog.field_supervisor")} value={employee.fullName} />
              <ConfirmField label={t("permissions_center.confirm_dialog.field_page")} value={pageLabel(t, pendingWrite.row.page)} />
              <ConfirmField label={t("permissions_center.confirm_dialog.field_action")} value={actionLabel(t, pendingWrite.row.action)} />
              <ConfirmField label={t("permissions_center.confirm_dialog.field_scope")} value={scopeLabel} />
              <ConfirmField
                label={t("permissions_center.confirm_dialog.field_current_state")}
                value={overrideValueLabel(t, pendingWrite.row.assigned)}
              />
              <ConfirmField
                label={t("permissions_center.confirm_dialog.field_requested_state")}
                value={overrideValueLabel(t, pendingWrite.type === "reset" ? null : pendingWrite.type)}
              />
            </dl>
          )}

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("permissions_center.confirm_dialog.reason_label")}
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("permissions_center.confirm_dialog.reason_placeholder")}
              disabled={writeMutation.isPending}
              data-testid="input-permission-change-reason"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={writeMutation.isPending}>
              {t("permissions_center.confirm_dialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmWrite();
              }}
              disabled={writeMutation.isPending}
              data-testid="button-confirm-permission-change"
            >
              {writeMutation.isPending ? <Loader2Spin className="me-2" /> : null}
              {t("permissions_center.confirm_dialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Small spinner wrapper so every loading spot in this file uses one identical glyph. */
function Loader2Spin({ className = "" }: { className?: string }) {
  return <Loader2 className={`h-4 w-4 animate-spin text-rassco ${className}`} />;
}

/**
 * The merged "who am I editing" + KPI strip (OPS-PERM-S1-F5 §2/§4/§5) — one wide surface, no
 * nested boxes: SupervisorIdentity + a real "تغيير المشرف" action, then role/region/effective-
 * scope fields, then PermissionSummary (the frozen four-metric KPI cluster) pinned to the far
 * side. Never invents an organizational title (e.g. "مدير مستودع") — only the real role is shown.
 */
function ContextStrip({
  employee,
  snapshot,
  regionName,
  summary,
  onChangeSupervisor,
}: {
  employee: UserSafe;
  snapshot: EmployeePermissionSnapshot;
  regionName?: string;
  summary: { total: number; defaultCount: number; grantedCount: number; revokedCount: number; effectiveCount: number };
  onChangeSupervisor: () => void;
}) {
  const { t } = useTranslation();

  // Derived only — the scope of whichever permission is currently effectively allowed, never a
  // separately invented value (see DataScopeCard's identical computation for the full tab).
  const firstAllowed = snapshot.permissions.find((r) => r.effective.allowed);
  const effectiveScopeLabel =
    firstAllowed && firstAllowed.effective.allowed ? dataScopeLabel(t, firstAllowed.effective.scope) : "—";

  return (
    <div className="rounded-2xl bg-white shadow-sm px-6 py-5">
      <div className="flex flex-wrap items-center gap-6">
        <SupervisorIdentity employee={employee} snapshot={snapshot} onChangeSupervisor={onChangeSupervisor} />

        <span className="h-12 w-px bg-rassco-border hidden md:block" />
        <ContextField label={t("permissions_center.hero.role_label")} value={getRoleLabel(employee.role)} icon={<UserCog className="h-4 w-4" />} />
        <span className="h-12 w-px bg-rassco-border hidden md:block" />
        <ContextField
          label={t("permissions_center.hero.region_label")}
          value={regionName || (snapshot.regionId ? snapshot.regionId : t("permissions_center.no_region"))}
          icon={<MapPin className="h-4 w-4" />}
          warn={!snapshot.regionId}
        />
        <span className="h-12 w-px bg-rassco-border hidden md:block" />
        <ContextField
          label={t("permissions_center.scope_tab.effective_scope_label")}
          value={effectiveScopeLabel}
          icon={<Boxes className="h-4 w-4" />}
        />

        <div className="ms-auto">
          <PermissionSummary t={t} summary={summary} />
        </div>
      </div>

      {!snapshot.isActive && (
        <div className="flex items-start gap-2 rounded-xl bg-destructive/5 p-3 mt-4 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{t("permissions_center.inactive_account_warning")}</span>
        </div>
      )}
      {!snapshot.regionId && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 mt-4 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{t("permissions_center.no_region_warning")}</span>
        </div>
      )}
    </div>
  );
}

/** Identity block of the context strip: photo/initials, name, active-state dot, and the real
 * "change supervisor" action — split out from ContextStrip as its own unit (OPS-PERM-S1-F5
 * structural rebuild) rather than inline markup mixed with the field/KPI clusters. */
function SupervisorIdentity({
  employee,
  snapshot,
  onChangeSupervisor,
}: {
  employee: UserSafe;
  snapshot: EmployeePermissionSnapshot;
  onChangeSupervisor: () => void;
}) {
  const { t } = useTranslation();
  const init = employee.fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <div className="flex items-center gap-4">
      {employee.profileImage ? (
        <img src={employee.profileImage} alt="" className="h-16 w-16 rounded-2xl object-cover shrink-0" />
      ) : (
        <div className="h-16 w-16 rounded-2xl bg-rassco/15 text-rassco flex items-center justify-center text-xl font-bold shrink-0">
          {init}
        </div>
      )}
      <div className="min-w-[11rem]">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold text-rassco-text leading-tight">{employee.fullName}</h2>
          <span
            className={`h-2.5 w-2.5 rounded-full shrink-0 ${snapshot.isActive ? "bg-green-500" : "bg-rassco-gray"}`}
            title={snapshot.isActive ? t("permissions_center.active_badge") : t("permissions_center.inactive_badge")}
          />
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">{t("permissions_center.hero.selected_badge")}</p>
        <button type="button" onClick={onChangeSupervisor} className="text-sm font-semibold text-rassco hover:underline mt-1">
          {t("permissions_center.hero.change_supervisor")}
        </button>
      </div>
    </div>
  );
}

function ContextField({ label, value, icon, warn }: { label: string; value: string; icon: ReactNode; warn?: boolean }) {
  return (
    <div className="min-w-[8.5rem]">
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        {icon}
        {label}
      </p>
      <p className={`text-base font-bold truncate mt-0.5 ${warn ? "text-amber-700" : "text-rassco-text"}`}>{value}</p>
    </div>
  );
}

/** The frozen four-metric permissions summary (OPS-PERM-S1-F5): الافتراضية / الممنوحة يدويًا /
 * المسحوبة يدويًا / الصلاحيات الفعلية — every value a plain derived count from the real snapshot
 * (see `summary` above), never reduced to three tiles for visual convenience. Extracted as its
 * own component so the KPI cluster is a real, independently testable unit. */
function PermissionSummary({
  t,
  summary,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  summary: { total: number; defaultCount: number; grantedCount: number; revokedCount: number; effectiveCount: number };
}) {
  const kpis = [
    { icon: ShieldQuestion, tone: "text-rassco-text", value: summary.defaultCount, label: t("permissions_center.toggle.default") },
    { icon: ShieldCheck, tone: "text-green-600", value: summary.grantedCount, label: t("permissions_center.summary.granted_label") },
    { icon: ShieldX, tone: "text-rose-600", value: summary.revokedCount, label: t("permissions_center.summary.revoked_label") },
    { icon: ShieldCheck, tone: "text-rassco", value: summary.effectiveCount, label: t("permissions_center.summary.effective_label") },
  ];

  return (
    <div className="flex flex-col items-end gap-2">
      <span className="text-xs font-bold text-muted-foreground">{t("permissions_center.summary_heading")}</span>
      <div className="flex items-center gap-2.5">
        {kpis.map((k) => (
          <div
            key={k.label}
            className="rounded-2xl border border-rassco-border/60 bg-muted/20 px-4 py-2.5 text-center min-w-[92px] shrink-0"
          >
            <div className="flex items-center justify-center gap-1.5">
              <k.icon className={`h-4 w-4 ${k.tone}`} />
              <span className={`text-2xl font-extrabold leading-none ${k.tone}`}>{k.value}</span>
            </div>
            <p className="text-xs font-medium text-muted-foreground leading-tight mt-1.5 whitespace-nowrap">{k.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Status filter + search for the merged "الوصول والصلاحيات" tab (OPS-PERM-S1-F5 structural
 * rebuild — replaces the previous flat 5-pill-button row with a real dropdown control, matching
 * the reference toolbar's composition). The five options remain mutually exclusive views of the
 * same page list, not combinable facets — same `filterMode` state and filtering logic as before,
 * only the control surface changed. No export control is rendered: there is no real backend
 * export action for this data today, and this toolbar never renders a UI-only stub for one. */
function PermissionsToolbar({
  t,
  searchTerm,
  onSearchChange,
  filterMode,
  onFilterChange,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  searchTerm: string;
  onSearchChange: (v: string) => void;
  filterMode: PageFilterMode;
  onFilterChange: (v: PageFilterMode) => void;
}) {
  const modes: { value: PageFilterMode; labelKey: string }[] = [
    { value: "all", labelKey: "permissions_center.filters.all" },
    { value: "allowed", labelKey: "permissions_center.filters.allowed" },
    { value: "denied", labelKey: "permissions_center.filters.denied" },
    { value: "overridden", labelKey: "permissions_center.filters.overridden" },
    { value: "locked", labelKey: "permissions_center.filters.locked" },
  ];
  return (
    <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
      <div className="relative sm:w-60 shrink-0">
        <select
          value={filterMode}
          onChange={(e) => onFilterChange(e.target.value as PageFilterMode)}
          className="w-full h-11 appearance-none rounded-full border border-rassco-border/70 bg-white ps-4 pe-9 text-sm font-semibold text-rassco-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="select-status-filter"
        >
          {modes.map((m) => (
            <option key={m.value} value={m.value}>
              {t(m.labelKey)}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      </div>
      <div className="relative sm:w-72">
        <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("permissions_center.filters.search_placeholder")}
          className="ps-10 h-11 text-sm"
          data-testid="input-search-pages"
        />
      </div>
    </div>
  );
}

/** One real governed page rendered as a compact card (OPS-PERM-S1-F5 structural rebuild): icon
 * header + description, a row of SELECTABLE capability chips (state dot per action), and the
 * derived default/denied/allowed mini-stat row — always visible. Selecting a chip reveals
 * SelectedActionDetail for that one action only; no page ever renders every action's controls
 * permanently expanded. Never a frontend-only flag: every count/state here comes straight from
 * this page's own snapshot rows. */
function GovernedPageCard({
  t,
  page,
  rows,
  scopeLabel,
  disabled,
  onGrant,
  onRevoke,
  onReset,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  page: string;
  rows: EmployeePermissionRow[];
  scopeLabel: string;
  disabled: boolean;
  onGrant: (row: EmployeePermissionRow) => void;
  onRevoke: (row: EmployeePermissionRow) => void;
  onReset: (row: EmployeePermissionRow) => void;
}) {
  const [selectedAction, setSelectedAction] = useState<string | null>(null);
  // Open by default so every existing capability chip stays immediately visible/testable — the
  // "إدارة الصلاحيات" control is a real, working collapse toggle (an Admin scanning many cards can
  // fold the ones they're not touching), never a hidden gate the Admin must discover first.
  const [managing, setManaging] = useState(true);
  const Icon = pageIcon(page);
  const effectiveCount = rows.filter((r) => r.effective.allowed).length;
  const deniedCount = rows.length - effectiveCount;
  const defaultCount = rows.filter((r) => r.defaultGrant).length;
  const hasOverride = rows.some((r) => r.assigned !== null);
  const description = pageDescription(t, page);
  const selectedRow = selectedAction ? rows.find((r) => r.action === selectedAction) ?? null : null;
  // The catalog's own "view" action IS this page's real, canonical page-level access permission
  // (permission-catalog.ts lists "view" for every governed page) — surfaced as its own always-
  // visible badge, never a separately invented page-access concept.
  const viewRow = rows.find((r) => r.action === "view") ?? null;

  return (
    <div className="rounded-2xl bg-white shadow-sm p-5 flex flex-col gap-4 border border-rassco-border/40">
      <div className="flex items-start gap-3.5">
        <span className="h-12 w-12 rounded-2xl bg-rassco/10 text-rassco flex items-center justify-center shrink-0">
          <Icon className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-bold text-rassco-text">{pageLabel(t, page)}</h3>
            {hasOverride && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                {t("permissions_center.page_access.override_badge")}
              </span>
            )}
          </div>
          {description ? <p className="text-sm text-muted-foreground mt-1">{description}</p> : null}
        </div>
        <span className="text-xs font-medium text-muted-foreground shrink-0">{scopeLabel}</span>
      </div>

      {viewRow && (
        <div className="flex items-center justify-between rounded-xl bg-muted/30 px-3.5 py-2.5">
          <span className="text-xs font-bold text-muted-foreground">{t("permissions_center.page_access.page_access_label")}</span>
          {viewRow.effective.allowed ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-bold text-green-700">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              {t("permissions_center.effective_allowed")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-sm font-bold text-rose-700">
              <ShieldX className="h-4 w-4 shrink-0" />
              {t("permissions_center.effective_denied")}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <MiniStat icon={ShieldQuestion} tone="text-rassco-text" value={defaultCount} label={t("permissions_center.toggle.default")} />
        <MiniStat icon={ShieldX} tone="text-rose-600" value={deniedCount} label={t("permissions_center.effective_denied")} />
        <MiniStat icon={ShieldCheck} tone="text-green-600" value={effectiveCount} label={t("permissions_center.effective_allowed")} />
      </div>

      <button
        type="button"
        onClick={() => setManaging((v) => !v)}
        aria-expanded={managing}
        data-testid={`button-manage-${page}`}
        className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-rassco text-white text-sm font-bold py-2.5 hover:bg-rassco/90 transition-colors"
      >
        <SlidersHorizontal className="h-4 w-4" />
        {managing ? t("permissions_center.page_access.manage_cta_close") : t("permissions_center.page_access.manage_cta")}
        <ChevronDown className={`h-4 w-4 transition-transform ${managing ? "rotate-180" : ""}`} />
      </button>

      {managing && (
        <div className="space-y-3 pt-3 border-t border-rassco-border/60">
          <PermissionChipRow
            rows={rows}
            selectedAction={selectedAction}
            onSelect={(action) => setSelectedAction((prev) => (prev === action ? null : action))}
          />

          {selectedRow ? (
            <SelectedActionDetail
              row={selectedRow}
              disabled={disabled}
              onGrant={() => onGrant(selectedRow)}
              onRevoke={() => onRevoke(selectedRow)}
              onReset={() => onReset(selectedRow)}
            />
          ) : (
            <p className="text-xs text-muted-foreground px-1">{t("permissions_center.page_access.manage_prompt")}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The always-visible capability-chip row (OPS-PERM-S1-F5 structural rebuild) — each chip is a
 * real toggleable control (not decorative badge text): clicking one selects it as the current
 * SelectedActionDetail target, clicking the already-selected one closes the detail. The colored
 * dot still encodes the real effective allow/deny state, unchanged from before. */
function PermissionChipRow({
  rows,
  selectedAction,
  onSelect,
}: {
  rows: EmployeePermissionRow[];
  selectedAction: string | null;
  onSelect: (action: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      {rows.map((row) => {
        const active = selectedAction === row.action;
        return (
          <button
            key={row.action}
            type="button"
            onClick={() => onSelect(row.action)}
            aria-pressed={active}
            data-testid={`button-select-action-${row.page}-${row.action}`}
            className={`inline-flex items-center gap-2 text-sm font-medium rounded-full px-3.5 py-1.5 transition-colors ${
              active ? "bg-rassco/10 text-rassco ring-1 ring-inset ring-rassco/40" : "text-rassco-text bg-muted/60 hover:bg-muted"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${row.effective.allowed ? "bg-green-500" : "bg-rose-400"}`} />
            {actionLabel(t, row.action)}
          </button>
        );
      })}
    </div>
  );
}

function MiniStat({ icon: Icon, tone, value, label }: { icon: LucideIcon; tone: string; value: number; label: string }) {
  return (
    <div className="flex-1 rounded-xl bg-muted/40 py-2.5 text-center">
      <div className="flex items-center justify-center gap-1.5">
        <Icon className={`h-4 w-4 ${tone}`} />
        <span className={`text-base font-bold ${tone}`}>{value}</span>
      </div>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}

/** On-demand detail for exactly one selected capability (OPS-PERM-S1-F5 structural rebuild —
 * replaces the previous permanently-expanded per-action row list). Shows the real effective
 * result, its real source/reason and scope (straight from the backend evaluator, never a
 * simplified "default vs manual" guess), and only the actions that are actually valid from the
 * current state — an already-granted action never offers "Grant" again as a no-op. Same
 * onGrant/onRevoke/onReset handlers as before, wired to the identical confirm-dialog + mutation
 * flow (OPS-PERM-S1-F5 functional freeze). */
function SelectedActionDetail({
  row,
  disabled,
  onGrant,
  onRevoke,
  onReset,
}: {
  row: EmployeePermissionRow;
  disabled: boolean;
  onGrant: () => void;
  onRevoke: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const editable = isRowEditable(row);

  return (
    <div
      data-testid={`row-permission-${row.page}-${row.action}`}
      className="rounded-xl bg-muted/25 px-4 py-3.5 space-y-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">{t("permissions_center.detail.permission_label")}</p>
          <p className="text-base font-semibold text-rassco-text mt-0.5">{actionLabel(t, row.action)}</p>
        </div>
        <div className="text-end">
          <p className="text-xs text-muted-foreground">{t("permissions_center.detail.effective_state_label")}</p>
          {row.effective.allowed ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-700 mt-0.5">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              {t("permissions_center.effective_allowed")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-rose-700 mt-0.5">
              <ShieldX className="h-4 w-4 shrink-0" />
              {t("permissions_center.effective_denied")}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-muted-foreground">{t("permissions_center.detail.source_label")}</p>
          <p className="text-sm font-medium text-rassco-text mt-0.5">
            {row.effective.allowed ? grantSourceLabel(t, row.effective.reason) : denyReasonLabel(t, row.effective.reason)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("permissions_center.detail.scope_label")}</p>
          <p className="text-sm font-medium text-rassco-text mt-0.5">
            {row.effective.allowed ? dataScopeLabel(t, row.effective.scope) : "—"}
          </p>
        </div>
      </div>

      {editable ? (
        <div className="flex flex-wrap gap-2 pt-2 border-t border-rassco-border/60">
          {/* State-aware actions only — an already-effective decision never offers itself again as a
              no-op: an inherited/default ALLOW only offers Revoke, an inherited/default DENY only
              offers Grant. An explicit override (assigned grant/revoke) always offers its opposite
              plus Reset. */}
          {row.assigned !== "grant" && !(row.assigned === null && row.effective.allowed) && (
            <ActionButton tone="positive" disabled={disabled} onClick={onGrant}>
              {t("permissions_center.toggle.grant")}
            </ActionButton>
          )}
          {row.assigned !== "revoke" && !(row.assigned === null && !row.effective.allowed) && (
            <ActionButton tone="negative" disabled={disabled} onClick={onRevoke}>
              {t("permissions_center.toggle.revoke")}
            </ActionButton>
          )}
          {row.assigned !== null && (
            <ActionButton tone="neutral" disabled={disabled} onClick={onReset}>
              {t("permissions_center.toggle.default")}
            </ActionButton>
          )}
        </div>
      ) : (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground pt-2 border-t border-rassco-border/60">
                <Lock className="h-4 w-4" />
                {t("permissions_center.not_available_for_role")}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t("permissions_center.not_available_hint")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

/** One real, standalone action button (OPS-PERM-S1-F5 structural rebuild — replaces the previous
 * three-way segmented Default/Grant/Revoke toggle, since SelectedActionDetail now only ever
 * offers the 1-2 actions actually valid from the current state, never the current state itself
 * as a no-op action). Slate for "reset to inherited default" — deliberately never black/near-
 * black and never the brand teal (teal is reserved for primary interaction/selection). */
function ActionButton({
  tone,
  disabled,
  onClick,
  children,
}: {
  tone: "positive" | "neutral" | "negative";
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const toneClass =
    tone === "positive"
      ? "bg-green-600 text-white hover:bg-green-700"
      : tone === "negative"
        ? "bg-rose-600 text-white hover:bg-rose-700"
        : "bg-slate-200 text-slate-700 hover:bg-slate-300";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${toneClass}`}
    >
      {children}
    </button>
  );
}

/** Shared renderer for both locked grids — visually distinct per variant (§9/§11: ADMIN-ONLY ≠
 * NOT YET GOVERNED must never look the same), never a Grant/Revoke control in either.
 *
 * Ungoverned pages (OPS-PERM-S1-F5 structural rebuild): a real compact card grid, one centered
 * semantic icon per tile — the page's own real icon from the nav registry, never a generic
 * lock/link glyph and never a floating icon-with-corner-badge composite — plus the Arabic page
 * name, its real route when one exists, and the "غير مربوطة بعد" status line.
 *
 * Admin-only pages render as wider, rose-tinted cards (unchanged shape — already close to the
 * approved reference). */
function LockedSection({
  t,
  variant,
  heading,
  subtitle,
  pages,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  variant: "ungoverned" | "admin-only";
  heading: string;
  subtitle: string;
  pages: RealUncatalogedPage[];
}) {
  const badgeKey = variant === "admin-only" ? "admin_only_badge" : "ungoverned_badge";
  const reasonKey = variant === "admin-only" ? "admin_only_reason" : "ungoverned_reason";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <h3 className="text-sm font-bold text-rassco-text">{heading}</h3>
        <span className="text-xs font-bold text-muted-foreground bg-muted rounded-full px-2 py-0.5">{pages.length}</span>
      </div>
      <p className="text-xs text-muted-foreground px-1 -mt-1.5">{subtitle}</p>
      {variant === "ungoverned" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {pages.map((page) => (
            <div
              key={page.id}
              className="rounded-2xl bg-white border border-rassco-border/70 p-4 space-y-2.5 hover:border-rassco/30 hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="inline-flex h-11 w-11 rounded-xl bg-muted/60 text-rassco-gray items-center justify-center shrink-0">
                  <page.icon className="h-5 w-5" />
                </span>
                <Lock className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0 mt-1" />
              </div>
              <div>
                <p className="text-sm font-bold text-rassco-text truncate">{t(page.labelKey)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t(`permissions_center.page_access.${reasonKey}`)}</p>
                <p className="text-xs text-muted-foreground/80">{t("permissions_center.page_access.ungoverned_locked_note")}</p>
              </div>
              {page.href ? (
                <p className="text-[11px] text-muted-foreground/70 truncate pt-1 border-t border-rassco-border/50" dir="ltr">
                  {page.href}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {pages.map((page) => (
            <div key={page.id} className="rounded-2xl bg-rose-50 border border-rose-200/80 p-4 space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <span className="inline-flex h-11 w-11 rounded-xl bg-white text-rose-500 items-center justify-center shadow-sm shrink-0">
                  <page.icon className="h-5 w-5" />
                </span>
                <Badge variant="outline" className="text-xs font-semibold text-rose-700 border-rose-300 bg-white/60 whitespace-nowrap shrink-0">
                  {t(`permissions_center.page_access.${badgeKey}`)}
                </Badge>
              </div>
              <div>
                <p className="text-sm font-bold text-rassco-text truncate">{t(page.labelKey)}</p>
                <p className="text-xs text-rose-700/80 mt-0.5">{t(`permissions_center.page_access.${reasonKey}`)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Dedicated Data Scope section (OPS-PERM-S1-F5 §12) — role, hard ceiling, assigned region, and
 * effective scope, never implying GLOBAL for a non-admin: hardCeilingScope comes straight from the
 * server's own snapshot, and the caption below is only ever the frozen, honest default. */
function DataScopeCard({
  t,
  snapshot,
  regionName,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  snapshot: EmployeePermissionSnapshot;
  regionName?: string;
}) {
  const firstAllowed = snapshot.permissions.find((r) => r.effective.allowed);
  const effectiveScopeLabel =
    firstAllowed && firstAllowed.effective.allowed
      ? dataScopeLabel(t, firstAllowed.effective.scope)
      : t("permissions_center.scope_tab.effective_scope_none");

  return (
    <div className="rounded-2xl bg-white shadow-sm p-6 space-y-5">
      <p className="text-sm text-muted-foreground">{t("permissions_center.scope_tab.subtitle")}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl bg-muted/40 p-5">
          <p className="text-xs text-muted-foreground">{t("permissions_center.scope_tab.role_label")}</p>
          <p className="text-xl font-bold text-rassco-text mt-1.5">{getRoleLabel(snapshot.role)}</p>
        </div>
        <div className="rounded-xl bg-muted/40 p-5">
          <p className="text-xs text-muted-foreground">{t("permissions_center.scope_tab.hard_ceiling_label")}</p>
          <p className="text-xl font-bold text-rassco-text mt-1.5">
            {snapshot.hardCeilingScope ? dataScopeLabel(t, snapshot.hardCeilingScope as DataScope) : "—"}
          </p>
        </div>
        <div className="rounded-xl bg-muted/40 p-5">
          <p className="text-xs text-muted-foreground">{t("permissions_center.scope_tab.assigned_region_label")}</p>
          <p className={`text-xl font-bold mt-1.5 ${snapshot.regionId ? "text-rassco-text" : "text-amber-700"}`}>
            {regionName || (snapshot.regionId ? snapshot.regionId : t("permissions_center.no_region"))}
          </p>
        </div>
        <div className="rounded-xl bg-muted/40 p-5">
          <p className="text-xs text-muted-foreground">{t("permissions_center.scope_tab.effective_scope_label")}</p>
          <p className="text-xl font-bold text-rassco-text mt-1.5">{effectiveScopeLabel}</p>
        </div>
      </div>
      <div className="flex items-start gap-2.5 rounded-xl bg-rassco/5 p-4 text-sm text-rassco-text">
        <MapPin className="h-4 w-4 mt-0.5 shrink-0 text-rassco" />
        <span>{t("permissions_center.hero.default_scope_caption")}</span>
      </div>
      <div className="flex items-start gap-2.5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
        <Lock className="h-4 w-4 mt-0.5 shrink-0" />
        <span>{t("permissions_center.scope_tab.no_global_note")}</span>
      </div>
    </div>
  );
}

/** Change History (OPS-PERM-S1-F5 §13) — a scannable activity feed (who / what permission /
 * previous → new / when / reason), never raw JSON or a bare data table as the primary UX. Reads
 * the exact same audit rows as before — unchanged. */
function AuditActivityList({
  t,
  dir,
  auditQuery,
  usersById,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  dir: string;
  auditQuery: ReturnType<typeof useQuery<PermissionChangeAuditEntry[]>>;
  usersById: Map<string, UserSafe>;
}) {
  return (
    <div className="rounded-2xl bg-white shadow-sm">
      {auditQuery.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
          <Loader2Spin />
          <span>{t("permissions_center.loading_audit")}</span>
        </div>
      ) : !auditQuery.data || auditQuery.data.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">{t("permissions_center.audit.empty")}</p>
      ) : (
        <ul className="divide-y divide-rassco-border/60">
          {auditQuery.data.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3.5 px-5 py-4">
              <span className="mt-0.5 h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                <History className="h-5 w-5 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="text-base font-semibold text-rassco-text">{permissionLabel(t, entry.page, entry.action)}</p>
                  <p className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(entry.changedAt).toLocaleString(dir === "rtl" ? "ar-SA" : "en-US")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {overrideValueLabel(t, entry.oldValue as OverrideValue | null)}
                  </Badge>
                  <span className="text-muted-foreground text-xs">→</span>
                  <Badge variant="outline" className="text-xs">
                    {overrideValueLabel(t, entry.newValue as OverrideValue | null)}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t("permissions_center.audit.changed_by")}: {usersById.get(entry.changedBy)?.fullName || entry.changedBy}
                  {" · "}
                  {entry.reason || t("permissions_center.audit.no_reason")}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One labeled field in the pre-mutation confirmation summary (OPS-PERM-S1-F5 §11 — the Admin must
 * see Supervisor/Page/Action/current state/requested state/scope explicitly, never infer them from
 * prose alone). */
function ConfirmField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-rassco-text">{value}</dd>
    </div>
  );
}
