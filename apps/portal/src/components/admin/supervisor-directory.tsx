/**
 * OPS-PERM-S1-F5 — Permissions Center UI: the right-side Supervisor directory.
 *
 * Extracted from permissions-center.tsx (OPS-PERM-S1-F5 structural rebuild) as its own real
 * component boundary — a self-contained search/filter/select surface over the real supervisor
 * list the parent page already fetched (never a second data source). Directory rows show a real
 * photo (UserSafe's own profileImage) with an initials fallback, and "role · region" as the
 * subtitle — never a fabricated job title. Region filter options are the real regions this
 * Permissions Center's own supervisors are actually assigned to, never a hardcoded list.
 */
import { useMemo, useState } from "react";
import { ChevronDown, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/language";
import { getRoleLabel } from "@shared/roles";
import type { RegionWithStats, UserSafe } from "@shared/schema";

function initials(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function SupervisorAvatar({ user, size = 36 }: { user: UserSafe; size?: number }) {
  if (user.profileImage) {
    return (
      <img
        src={user.profileImage}
        alt=""
        className="rounded-full object-cover shrink-0"
        style={{ height: size, width: size }}
      />
    );
  }
  return (
    <span
      className="rounded-full bg-rassco/15 text-rassco flex items-center justify-center font-bold shrink-0"
      style={{ height: size, width: size, fontSize: size * 0.34 }}
    >
      {initials(user.fullName)}
    </span>
  );
}

interface SupervisorDirectoryProps {
  supervisors: UserSafe[];
  regionsById: Map<string, RegionWithStats>;
  selectedUserId: string | null;
  onSelect: (userId: string) => void;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
}

export function SupervisorDirectory({
  supervisors,
  regionsById,
  selectedUserId,
  onSelect,
  isLoading,
  error,
  onRetry,
}: SupervisorDirectoryProps) {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState("");
  const [regionFilter, setRegionFilter] = useState<string>("all");

  // Real regions this Permissions Center's own supervisors are actually assigned to — never a
  // hardcoded region list, and never a region no supervisor here has.
  const supervisorRegionOptions = useMemo(() => {
    const ids = new Set(supervisors.map((s) => s.regionId).filter((id): id is string => !!id));
    return Array.from(ids)
      .map((id) => regionsById.get(id))
      .filter((r): r is RegionWithStats => !!r)
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }, [supervisors, regionsById]);

  const filteredSupervisors = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return supervisors.filter((u) => {
      if (regionFilter !== "all" && u.regionId !== regionFilter) return false;
      if (!term) return true;
      return (
        u.fullName.toLowerCase().includes(term) ||
        u.username.toLowerCase().includes(term) ||
        u.email.toLowerCase().includes(term)
      );
    });
  }, [supervisors, searchTerm, regionFilter]);

  return (
    <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
      <div className="p-4 space-y-3 border-b border-rassco-border/70">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-base font-bold text-rassco-text">{t("permissions_center.supervisors_heading")}</span>
          <span className="text-sm font-bold text-rassco bg-rassco/10 rounded-full px-2.5 py-0.5 min-w-[2rem] text-center">
            {filteredSupervisors.length}
          </span>
        </div>
        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t("permissions_center.search_placeholder")}
            className="ps-9 h-10 text-sm"
            data-testid="input-search-supervisors"
          />
        </div>
        {supervisorRegionOptions.length > 1 && (
          <div className="relative">
            <select
              value={regionFilter}
              onChange={(e) => setRegionFilter(e.target.value)}
              className="w-full h-10 appearance-none rounded-full border border-rassco-border/70 bg-white ps-3.5 pe-8 text-sm font-semibold text-rassco-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              data-testid="select-region-filter"
            >
              <option value="all">{t("permissions_center.page_access.region_filter_all")}</option>
              {supervisorRegionOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">{t("permissions_center.loading_employees")}</span>
        </div>
      ) : error ? (
        <div className="text-center py-8 space-y-2 px-3">
          <p className="text-sm text-destructive">{error.message}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t("permissions_center.retry")}
          </Button>
        </div>
      ) : filteredSupervisors.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8 px-3">
          {searchTerm || regionFilter !== "all"
            ? t("permissions_center.no_supervisors_search")
            : t("permissions_center.no_supervisors")}
        </p>
      ) : (
        <ul className="max-h-[min(70vh,720px)] overflow-y-auto py-1.5">
          {filteredSupervisors.map((supervisor) => {
            const active = supervisor.id === selectedUserId;
            const region = supervisor.regionId ? regionsById.get(supervisor.regionId) : undefined;
            return (
              <li key={supervisor.id} className="px-2">
                <button
                  type="button"
                  onClick={() => onSelect(supervisor.id)}
                  data-testid={`button-select-supervisor-${supervisor.id}`}
                  aria-current={active}
                  className={`w-full flex items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors border-s-[3px] ${
                    active
                      ? "bg-rassco/10 border-s-rassco ring-1 ring-inset ring-rassco/20"
                      : "border-s-transparent hover:bg-muted/50"
                  }`}
                >
                  <span className="relative shrink-0">
                    <SupervisorAvatar user={supervisor} size={44} />
                    <span
                      className={`absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full ring-2 ring-white ${
                        supervisor.isActive ? "bg-green-500" : "bg-rassco-gray/60"
                      }`}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold text-rassco-text truncate">{supervisor.fullName}</span>
                    <span className="block text-xs text-muted-foreground truncate mt-0.5">
                      {getRoleLabel(supervisor.role)}
                      {region ? ` · ${region.name}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
