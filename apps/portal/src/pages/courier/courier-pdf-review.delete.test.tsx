/**
 * Delete an uploaded PDF report from the review page: the button is shown to an admin only,
 * never for an applied report, asks for confirmation, and sends DELETE /api/courier/pdf/:id.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route } from "wouter";
import { renderWithProviders } from "@/test/render-with-providers";
import { mockApiServer, http, HttpResponse } from "@/test/mock-api-server";
import CourierPdfReviewPage from "./courier-pdf-review";

function serveReport(status: string) {
  mockApiServer.use(
    http.get("/api/courier/pdf/27", () =>
      HttpResponse.json({
        id: 27,
        requestId: null,
        fileName: "report-27.pdf",
        filePath: "https://drive.google.com/file/d/abc123/view",
        status,
        extractedJson: JSON.stringify({ devices: [] }),
        overallConfidence: 0.9,
      })
    )
  );
}

function renderPage(role: "admin" | "supervisor" | "technician") {
  return renderWithProviders(
    <Route path="/courier/pdf/:id">
      <CourierPdfReviewPage />
    </Route>,
    { route: "/courier/pdf/27", authOverrides: { role } }
  );
}

describe("PDF report review — delete button", () => {
  it("admin + pending report: confirm dialog, then DELETE /api/courier/pdf/27", async () => {
    serveReport("pending");
    const deleted: string[] = [];
    mockApiServer.use(
      http.delete("/api/courier/pdf/:id", ({ params }) => {
        deleted.push(String(params.id));
        return HttpResponse.json({ success: true, id: 27, status: "deleted", deletionTaskId: 1 });
      })
    );
    renderPage("admin");

    fireEvent.click(await screen.findByTestId("button-delete-pdf-report"));
    expect(deleted).toEqual([]); // nothing is sent before confirmation
    fireEvent.click(await screen.findByTestId("button-confirm-delete-pdf-report"));
    await waitFor(() => expect(deleted).toEqual(["27"]));
  });

  it.each(["supervisor", "technician"] as const)("%s never sees the button", async (role) => {
    serveReport("pending");
    renderPage(role);
    await screen.findByText("report-27.pdf", { exact: false });
    expect(screen.queryByTestId("button-delete-pdf-report")).toBeNull();
  });

  it("an applied report has no delete button, even for an admin", async () => {
    serveReport("applied");
    renderPage("admin");
    await screen.findByText("report-27.pdf", { exact: false });
    expect(screen.queryByTestId("button-delete-pdf-report")).toBeNull();
  });
});
