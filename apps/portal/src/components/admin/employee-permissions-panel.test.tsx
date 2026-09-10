/**
 * OPS-PERM-S1-F5 — EmployeePermissionsPanel behavior test.
 *
 * Exercises the actual read/write contract this panel talks to
 * (GET/POST /api/admin/permissions/employees/:userId/*), mocked at the network layer via MSW —
 * proving grant/revoke/reset send the right payload and that the row reflects the server's
 * response after the panel refetches, not just that the dialog opens.
 *
 * Visual structure (OPS-PERM-S1-F5 structural rebuild): a compact identity bar, a derived
 * four-metric summary strip, then three tabs — "الوصول والصلاحيات" (one compact card per real
 * governed page; each capability is a chip carrying data-testid="button-select-action-
 * {page}-{action}", and selecting a chip reveals its own detail block carrying
 * data-testid="row-permission-{page}-{action}" — never every action's controls permanently
 * expanded), "نطاق البيانات", and "سجل التغييرات". All assertions below key off data-testid and
 * exact label text, not the surrounding layout, so they hold across that visual redesign.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/render-with-providers";
import { mockApiServer, http, HttpResponse } from "@/test/mock-api-server";
import { createRoleFixture } from "@/test/fixtures";
import { EmployeePermissionsPanel } from "./employee-permissions-panel";
import type { EmployeePermissionSnapshot, PermissionChangeAuditEntry } from "@/lib/permissions-center";
import type { RegionWithStats } from "@shared/schema";

const supervisor = createRoleFixture("supervisor", {
  id: "sup-1",
  fullName: "Supervisor One",
  username: "sup.one",
  regionId: "region-1",
});

function buildSnapshot(overrides: Partial<EmployeePermissionSnapshot> = {}): EmployeePermissionSnapshot {
  return {
    userId: supervisor.id,
    role: "supervisor",
    isActive: true,
    regionId: "region-1",
    hardCeilingScope: "REGION",
    permissions: [
      {
        page: "courier.requests",
        action: "view",
        defaultGrant: true,
        assigned: null,
        effective: { allowed: true, reason: "role-template", scope: "REGION" },
      },
      {
        page: "courier.requests",
        action: "create",
        defaultGrant: false,
        assigned: null,
        effective: { allowed: false, reason: "no-grant" },
      },
      {
        page: "warehouse.inventory",
        action: "update",
        defaultGrant: false,
        assigned: null,
        effective: { allowed: false, reason: "role-ceiling" },
      },
    ],
    ...overrides,
  };
}

function renderPanel(
  snapshot: EmployeePermissionSnapshot,
  audit: PermissionChangeAuditEntry[] = [],
  opts: { failGrant?: boolean } = {}
) {
  let current = snapshot;
  const grantCalls: Array<{ page: string; action: string; reason?: string }> = [];
  const revokeCalls: Array<{ page: string; action: string; reason?: string }> = [];
  const resetCalls: Array<{ page: string; action: string; reason?: string }> = [];

  const applyOverride = (page: string, action: string, value: "grant" | "revoke" | null) =>
    (current = {
      ...current,
      permissions: current.permissions.map((row) =>
        row.page === page && row.action === action
          ? {
              ...row,
              assigned: value,
              effective:
                value === "revoke"
                  ? { allowed: false, reason: "explicit-deny" as const }
                  : value === "grant"
                    ? { allowed: true, reason: "override" as const, scope: "REGION" as const }
                    : row.defaultGrant
                      ? { allowed: true, reason: "role-template" as const, scope: "REGION" as const }
                      : { allowed: false, reason: "no-grant" as const },
            }
          : row
      ),
    });

  mockApiServer.use(
    http.get(`/api/admin/permissions/employees/${supervisor.id}`, () => HttpResponse.json(current)),
    http.get(`/api/admin/permissions/employees/${supervisor.id}/audit`, () => HttpResponse.json(audit)),
    http.post(`/api/admin/permissions/employees/${supervisor.id}/grant`, async ({ request }) => {
      const body = (await request.json()) as { page: string; action: string; reason?: string };
      grantCalls.push(body);
      if (opts.failGrant) {
        return HttpResponse.json({ message: "فشل التحقق من الصلاحية" }, { status: 500 });
      }
      applyOverride(body.page, body.action, "grant");
      return HttpResponse.json({
        success: true,
        override: { id: "ovr-1", userId: supervisor.id, page: body.page, action: body.action, value: "grant", grantedBy: "admin-1", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      });
    }),
    http.post(`/api/admin/permissions/employees/${supervisor.id}/revoke`, async ({ request }) => {
      const body = (await request.json()) as { page: string; action: string; reason?: string };
      revokeCalls.push(body);
      applyOverride(body.page, body.action, "revoke");
      return HttpResponse.json({
        success: true,
        override: { id: "ovr-2", userId: supervisor.id, page: body.page, action: body.action, value: "revoke", grantedBy: "admin-1", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      });
    }),
    http.post(`/api/admin/permissions/employees/${supervisor.id}/reset`, async ({ request }) => {
      const body = (await request.json()) as { page: string; action: string; reason?: string };
      resetCalls.push(body);
      applyOverride(body.page, body.action, null);
      return HttpResponse.json({ success: true });
    })
  );

  const usersById = new Map([[supervisor.id, supervisor]]);
  const regionsById = new Map<string, RegionWithStats>([
    [supervisor.regionId as string, { id: supervisor.regionId, name: "منطقة الرياض" } as RegionWithStats],
  ]);
  const utils = renderWithProviders(
    <EmployeePermissionsPanel employee={supervisor} usersById={usersById} regionsById={regionsById} onChangeSupervisor={() => {}} />,
    { authOverrides: { role: "admin" } }
  );
  return { ...utils, grantCalls, revokeCalls, resetCalls };
}

// The test harness's default language isn't guaranteed to be Arabic (it renders English here) —
// every assertion below checks both, matching the existing grant test's own pattern.
const LABELS = {
  grant: ["منح", "Grant"],
  revoke: ["سحب", "Revoke"],
  reset: ["افتراضي", "Default"],
  denied: ["محظور", "Denied"],
  allowed: ["مسموح", "Allowed"],
  region: ["على مستوى المنطقة", "Region-level"],
  global: ["شامل", "Global"],
  accounting: ["المحاسبة والمالية", "Accounting & Finance"],
  writeError: ["تعذر تنفيذ التغيير", "Could not apply this change"],
} as const;

function byText(el: HTMLElement, candidates: readonly string[]) {
  return within(el).getByText((_, node) => !!node && candidates.some((c) => node.textContent === c));
}

function queryByText(el: HTMLElement, candidates: readonly string[]) {
  return within(el).queryByText((_, node) => !!node && candidates.some((c) => node.textContent === c));
}

/** Drives one grant/revoke/reset cycle through the real dialog UI (click toggle → fill reason →
 * confirm) and waits for the dialog to close — shared by the three mutation-type tests below so
 * each only has to assert its own type-specific outcome. */
async function performMutation(row: HTMLElement, toggleLabels: readonly string[]) {
  const button = within(row).getAllByRole("button").find((btn) => toggleLabels.includes(btn.textContent || ""));
  if (!button) throw new Error(`No "${toggleLabels.join("/")}" button found in row`);
  fireEvent.click(button);
  const confirmButton = await screen.findByTestId("button-confirm-permission-change");
  fireEvent.click(confirmButton);
}

/** Selects one capability's chip inside its governed card, revealing its SelectedActionDetail
 * block — the new interaction model replacing the old "open by default" row list. */
async function selectAction(page: string, action: string) {
  fireEvent.click(await screen.findByTestId(`button-select-action-${page}-${action}`));
  return screen.findByTestId(`row-permission-${page}-${action}`);
}

describe("OPS-PERM-S1-F5 — EmployeePermissionsPanel", () => {
  it("renders each governed page's real capability chips from the snapshot", async () => {
    renderPanel(buildSnapshot());

    await screen.findByText("Supervisor One");
    expect(screen.getByTestId("button-select-action-courier.requests-view")).toBeInTheDocument();
    expect(screen.getByTestId("button-select-action-courier.requests-create")).toBeInTheDocument();
  });

  it("selecting a capability chip reveals that action's detail and no other", async () => {
    renderPanel(buildSnapshot());
    await screen.findByText("Supervisor One");

    await selectAction("courier.requests", "view");
    expect(screen.getByTestId("row-permission-courier.requests-view")).toBeInTheDocument();
    expect(screen.queryByTestId("row-permission-courier.requests-create")).not.toBeInTheDocument();
  });

  it("resolves the assigned region's real name in the context card (data-scope display gap fix)", async () => {
    renderPanel(buildSnapshot());

    await screen.findByText("Supervisor One");
    // Was previously only a negative "no region" warning — now the actual region name from
    // /api/regions is shown whenever one is assigned.
    expect(screen.getAllByText("منطقة الرياض").length).toBeGreaterThan(0);
  });

  it("locks a row outside the role's hard ceiling instead of offering grant/revoke controls", async () => {
    renderPanel(buildSnapshot());
    await screen.findByText("Supervisor One");

    const lockedRow = await selectAction("warehouse.inventory", "update");
    expect(within(lockedRow).queryByText("منح")).not.toBeInTheDocument();
    expect(within(lockedRow).queryByText("Grant")).not.toBeInTheDocument();
  });

  it("grants a permission after confirming, sends the reason, and reflects the new state after refetch", async () => {
    const { grantCalls } = renderPanel(buildSnapshot());
    await screen.findByText("Supervisor One");

    const row = await selectAction("courier.requests", "create");
    const grantButtons = within(row).getAllByRole("button").filter((btn) => btn.textContent === "منح" || btn.textContent === "Grant");
    expect(grantButtons).toHaveLength(1);
    fireEvent.click(grantButtons[0]);

    const reasonInput = await screen.findByTestId("input-permission-change-reason");
    fireEvent.change(reasonInput, { target: { value: "Temporary coverage" } });

    const confirmButton = screen.getByTestId("button-confirm-permission-change");
    fireEvent.click(confirmButton);

    await waitFor(() => expect(grantCalls).toHaveLength(1));
    expect(grantCalls[0]).toMatchObject({ page: "courier.requests", action: "create", reason: "Temporary coverage" });

    // Dialog closes and the panel reflects the server's post-write state (from the refetched
    // snapshot): the row now reads as effectively allowed, and — since "Grant" is no longer a
    // valid next action once already granted — only Revoke/Reset remain offered.
    await waitFor(() => expect(screen.queryByTestId("button-confirm-permission-change")).not.toBeInTheDocument());
    await waitFor(() => {
      const updatedRow = screen.getByTestId("row-permission-courier.requests-create");
      expect(byText(updatedRow, LABELS.allowed)).toBeInTheDocument();
      expect(within(updatedRow).queryByText("منح")).not.toBeInTheDocument();
      expect(within(updatedRow).queryByText("Grant")).not.toBeInTheDocument();
    });
  });

  it("revokes a permission after confirming and reflects denied effective state after refetch (OPS-PERM-S1-F5 practical remediation §9)", async () => {
    const { revokeCalls } = renderPanel(buildSnapshot());
    await screen.findByText("Supervisor One");

    const row = await selectAction("courier.requests", "view");
    await performMutation(row, LABELS.revoke);

    await waitFor(() => expect(revokeCalls).toHaveLength(1));
    expect(revokeCalls[0]).toMatchObject({ page: "courier.requests", action: "view" });
    await waitFor(() => expect(screen.queryByTestId("button-confirm-permission-change")).not.toBeInTheDocument());
    await waitFor(() => {
      const updatedRow = screen.getByTestId("row-permission-courier.requests-view");
      expect(byText(updatedRow, LABELS.denied)).toBeInTheDocument();
    });
  });

  it("resets an override back to the default template after confirming (OPS-PERM-S1-F5 practical remediation §9)", async () => {
    const snapshot = buildSnapshot();
    snapshot.permissions[0] = {
      ...snapshot.permissions[0],
      assigned: "revoke",
      effective: { allowed: false, reason: "explicit-deny" },
    };
    const { resetCalls } = renderPanel(snapshot);
    await screen.findByText("Supervisor One");

    const row = await selectAction("courier.requests", "view");
    await performMutation(row, LABELS.reset);

    await waitFor(() => expect(resetCalls).toHaveLength(1));
    expect(resetCalls[0]).toMatchObject({ page: "courier.requests", action: "view" });
    await waitFor(() => expect(screen.queryByTestId("button-confirm-permission-change")).not.toBeInTheDocument());
    await waitFor(() => {
      const updatedRow = screen.getByTestId("row-permission-courier.requests-view");
      // Back to the role-template default (defaultGrant: true), never a leftover "denied" state.
      expect(byText(updatedRow, LABELS.allowed)).toBeInTheDocument();
    });
  });

  it("leaves the dialog open and the row unchanged when the mutation fails — never a false success", async () => {
    // Note: this test harness doesn't mount the app's <Toaster/>, so the error toast itself isn't
    // asserted here — the decisive proof of "no false success" is that the dialog stays open
    // (never auto-closes as onSuccess would) and the row keeps its pre-mutation denied state.
    renderPanel(buildSnapshot(), [], { failGrant: true });
    await screen.findByText("Supervisor One");

    const row = await selectAction("courier.requests", "create");
    await performMutation(row, LABELS.grant);

    await waitFor(() => expect(screen.getByTestId("button-confirm-permission-change")).not.toBeDisabled());
    expect(screen.getByTestId("button-confirm-permission-change")).toBeInTheDocument();
    expect(byText(row, LABELS.denied)).toBeInTheDocument();
  });

  it("keeps the region/data scope unchanged after a grant — a grant never widens scope beyond REGION", async () => {
    renderPanel(buildSnapshot());
    await screen.findByText("Supervisor One");

    const row = await selectAction("courier.requests", "create");
    await performMutation(row, LABELS.grant);

    await waitFor(() => expect(screen.queryByTestId("button-confirm-permission-change")).not.toBeInTheDocument());
    await waitFor(() => {
      const updatedRow = screen.getByTestId("row-permission-courier.requests-create");
      // The effective-state caption cites the real snapshot scope (REGION) — never GLOBAL, even
      // for a freshly-granted permission. It's rendered as one combined "(source · scope)" text
      // node, so a substring/regex match is needed rather than an exact-text match.
      expect(within(updatedRow).getByText(/(على مستوى المنطقة|Region-level)/)).toBeInTheDocument();
      expect(within(updatedRow).queryByText(/(شامل|Global)/)).not.toBeInTheDocument();
    });
  });

  it("shows Accounting and other real-but-uncataloged pages locked, never as a fake grantable toggle", async () => {
    renderPanel(buildSnapshot());

    await screen.findByText("Supervisor One");
    const accountingHeading = byText(document.body, LABELS.accounting);
    expect(accountingHeading).toBeInTheDocument();
    const accountingCard = accountingHeading.closest("div");
    expect(accountingCard).not.toBeNull();
    expect(queryByText(accountingCard as HTMLElement, LABELS.grant)).not.toBeInTheDocument();
  });

  it("filters the page list to allowed-only / denied-only / locked via the status filter", async () => {
    renderPanel(buildSnapshot());
    await screen.findByText("Supervisor One");

    fireEvent.change(screen.getByTestId("select-status-filter"), { target: { value: "locked" } });
    expect(byText(document.body, LABELS.accounting)).toBeInTheDocument();
    expect(screen.queryByTestId("button-select-action-courier.requests-view")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("select-status-filter"), { target: { value: "all" } });
    expect(screen.getByTestId("button-select-action-courier.requests-view")).toBeInTheDocument();
  });
});
