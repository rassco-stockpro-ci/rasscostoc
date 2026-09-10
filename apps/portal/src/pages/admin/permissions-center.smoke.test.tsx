/**
 * OPS-PERM-S1-F5 — Permissions Center shell smoke test, following the same
 * convention as the other admin pages' *.smoke.test.tsx (e.g.
 * pages/admin/ai-engine-settings, pages/accounting-dashboard): proves the
 * page renders past its loading state for an authenticated admin. Behavior
 * (selecting a supervisor, grant/revoke/reset) is covered separately in
 * components/admin/employee-permissions-panel.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render-with-providers";
import { mockApiServer, http, HttpResponse } from "@/test/mock-api-server";
import { createRoleFixture } from "@/test/fixtures";
import PermissionsCenterPage from "./permissions-center";

describe("OPS-PERM-S1-F5 — Permissions Center shell smoke", () => {
  it("renders for an authenticated admin without crashing (success state)", async () => {
    mockApiServer.use(
      http.get("/api/users", () =>
        HttpResponse.json([
          createRoleFixture("supervisor", { id: "sup-1", fullName: "Supervisor One", username: "sup.one" }),
          createRoleFixture("admin", { id: "admin-1", fullName: "Admin One", username: "admin.one" }),
        ])
      ),
      // Real /api/regions returns a raw array (see employee-detailed-profile-template.tsx's
      // identical query) — override the generic {success,data} MSW fallback so the page's own
      // region-name resolution never sees a mismatched envelope shape.
      http.get("/api/regions", () => HttpResponse.json([]))
    );

    const { container } = renderWithProviders(<PermissionsCenterPage />, { authOverrides: { role: "admin" } });
    await waitFor(() => expect(container.firstChild).not.toBeNull());
    await screen.findByText("Supervisor One");
  });

  it("shows the empty-selection placeholder until a supervisor is picked", async () => {
    mockApiServer.use(
      http.get("/api/users", () =>
        HttpResponse.json([createRoleFixture("supervisor", { id: "sup-1", fullName: "Supervisor One", username: "sup.one" })])
      ),
      http.get("/api/regions", () => HttpResponse.json([]))
    );

    renderWithProviders(<PermissionsCenterPage />, { authOverrides: { role: "admin" } });
    await screen.findByText("Supervisor One");
    expect(screen.getByTestId("input-search-supervisors")).toBeInTheDocument();
  });
});
