/**
 * OPS-PERM-S1-F5 — Permissions Center UI.
 *
 * Admin-only page (route-gated in App.tsx, same as every other /admin/* page) that surfaces the
 * OPS-PERM-S1-F4 Permission Engine: a compact, searchable supervisor directory on the start side
 * (region-filterable), and the selected employee's full permission snapshot + audit history in
 * the main pane (EmployeePermissionsPanel). V1 scope, unchanged from F4: only Supervisor-role
 * employees are manageable here — see PermissionsService's "Admin manages SUPERVISOR permissions"
 * comment.
 *
 * OPS-PERM-S1-F5 structural rebuild: the directory itself is a real, extracted component
 * (components/admin/supervisor-directory.tsx) — this page owns only the shared data (users,
 * regions) and the selection, never a second copy of the directory's own filtering state.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, ShieldQuestion } from "lucide-react";
import { useTranslation } from "@/lib/language";
import { apiRequest } from "@/lib/queryClient";
import type { RegionWithStats, UserSafe } from "@shared/schema";
import { EmployeePermissionsPanel } from "@/components/admin/employee-permissions-panel";
import { SupervisorDirectory } from "@/components/admin/supervisor-directory";

export default function PermissionsCenterPage() {
  const { t, dir } = useTranslation();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const usersQuery = useQuery<UserSafe[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/users");
      return res.json();
    },
  });
  const users = usersQuery.data ?? [];

  // Region names for the employee context/data-scope display — the same existing
  // /api/regions endpoint every other profile page already resolves regionId
  // through (see employee-detailed-profile-template.tsx), not a new source of truth.
  const regionsQuery = useQuery<RegionWithStats[]>({ queryKey: ["/api/regions"] });
  const regionsById = useMemo(() => {
    const rows = Array.isArray(regionsQuery.data) ? regionsQuery.data : [];
    return new Map(rows.map((r) => [r.id, r]));
  }, [regionsQuery.data]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const supervisors = useMemo(() => users.filter((u) => u.role === "supervisor"), [users]);

  // Keep the selection valid if the underlying user list changes (e.g. the selected employee's
  // role was changed away from supervisor by another admin session).
  useEffect(() => {
    if (selectedUserId && usersQuery.data && !supervisors.some((u) => u.id === selectedUserId)) {
      setSelectedUserId(null);
    }
  }, [supervisors, selectedUserId, usersQuery.data]);

  const selectedEmployee = selectedUserId ? usersById.get(selectedUserId) ?? null : null;

  return (
    <div className="space-y-5" dir={dir}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="h-14 w-14 rounded-2xl bg-rassco/10 flex items-center justify-center shrink-0">
            <ShieldCheck className="h-7 w-7 text-rassco" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-rassco-text leading-tight">{t("titles.permissions_center")}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{t("permissions_center.subtitle")}</p>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start">
        <SupervisorDirectory
          supervisors={supervisors}
          regionsById={regionsById}
          selectedUserId={selectedUserId}
          onSelect={setSelectedUserId}
          isLoading={usersQuery.isLoading}
          error={usersQuery.error as Error | null}
          onRetry={() => usersQuery.refetch()}
        />

        {selectedEmployee ? (
          <EmployeePermissionsPanel
            key={selectedEmployee.id}
            employee={selectedEmployee}
            usersById={usersById}
            regionsById={regionsById}
            onChangeSupervisor={() => setSelectedUserId(null)}
          />
        ) : (
          <div className="rounded-2xl bg-white shadow-sm flex items-center gap-5 p-10 min-h-[320px]">
            <div className="h-16 w-16 rounded-2xl bg-rassco/10 flex items-center justify-center shrink-0">
              <ShieldQuestion className="h-8 w-8 text-rassco" />
            </div>
            <div>
              <p className="font-bold text-rassco-text text-lg">{t("permissions_center.select_supervisor")}</p>
              <p className="text-sm text-muted-foreground mt-1">{t("permissions_center.select_supervisor_hint")}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
