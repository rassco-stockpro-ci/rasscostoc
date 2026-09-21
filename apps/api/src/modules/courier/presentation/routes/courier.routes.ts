import type { Express, Request, Response, NextFunction } from "express";
import path from "path";
import { bootstrapCourierModule } from "../../composition/courier.container";
import { requireAuth, requireAuthOrInternal, requireAdmin } from "@core/middlewares/auth.middleware";
import { requireCatalogedPermission } from "@core/middlewares/requireCatalogedPermission.middleware";
import {
  createExcelUpload,
  uploadErrorHandler,
  validateExcelUploadMiddleware,
} from "@core/uploads/upload-policy";

const EXCEL_TEMP_DIR = path.join(process.cwd(), "uploads", "temp");

const excelUpload = createExcelUpload(EXCEL_TEMP_DIR);

/**
 * Hotfix: JSON-only guard for the Zero-Storage register-drive endpoint.
 * Rejects multipart (and any other non-JSON content-type) with 415 before
 * the route handler — and therefore before any request-body parsing that
 * could touch file bytes — ever runs.
 */
function requireJsonContentType(req: Request, res: Response, next: NextFunction): void {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    res.status(415).json({
      success: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "This endpoint accepts Google Drive metadata as JSON only (Content-Type: application/json). Multipart and binary payloads are prohibited.",
    });
    return;
  }
  next();
}

export function registerCourierRoutes(app: Express): void {
  const controller = bootstrapCourierModule();

  // Requests CRUD
  // OPS-PERM-S2: real Permission Engine enforcement for the "courier.requests:view"
  // catalog entry — supervisor-role only (see requireCatalogedPermission's own doc
  // comment); every other role's access is unchanged.
  app.get("/api/courier/requests", requireAuth, requireCatalogedPermission("courier.requests", "view"), controller.getRequests);
  app.get("/api/courier/requests/export", requireAuth, controller.exportExcel);
  // OPS-PERM-S0-B1-B.MR1.B1: Admin authorization intentionally runs BEFORE
  // Multer's disk upload / magic-byte validation. Bulk import is Admin-only
  // (courier.service.ts resolveBulkImportRegionId); a non-Admin request must
  // never reach the point of writing a temp file to disk or invoking Excel
  // parsing/malware scanning in the first place — that would be authenticated
  // resource consumption before authorization, not a real access grant, but
  // still an unnecessary and avoidable attack surface for an unauthorized
  // actor. This is defense-in-depth: the service layer's own Admin check
  // remains the authoritative one for any non-HTTP/internal caller.
  app.post(
    "/api/courier/requests/import",
    requireAuth,
    requireAdmin,
    excelUpload.single("file"),
    validateExcelUploadMiddleware(),
    uploadErrorHandler,
    controller.importExcel,
  );
  app.get("/api/courier/requests/:id", requireAuth, controller.getRequest);
  app.post("/api/courier/requests", requireAuth, controller.createRequest);
  // OPS-PERM-S2: real Permission Engine enforcement for "courier.requests:update" —
  // supervisor-role only (see requireCatalogedPermission's own doc comment). Note:
  // "courier.requests:create" is deliberately NOT gated here — CourierService.createRequest
  // already permanently forbids every non-admin role, including supervisor, by explicit
  // owner decision (see courier-service-region-writer-contract.test.ts), so the catalog's
  // "create" entry currently has no real action to enforce; that catalog/business-logic
  // mismatch is flagged separately, not silently wired around.
  app.put("/api/courier/requests/:id", requireAuth, requireCatalogedPermission("courier.requests", "update"), controller.updateRequest);
  // OPS-PERM-S0-B0.I1: global, system-wide destructive operation — a proven
  // authenticated-but-unauthorized access defect (any operational role could
  // wipe every courier request). Restricted to Admin only. This changes only
  // WHO may reach the existing handler; deleteAllRequests's own behavior is
  // unchanged.
  app.delete("/api/courier/requests/all", requireAuth, requireAdmin, controller.deleteAllRequests);
  app.delete("/api/courier/requests/:id", requireAuth, controller.deleteRequest);

  // Request Items & Two-Phase Custody Acceptance
  app.get("/api/courier/requests/:requestId/items", requireAuth, controller.getRequestItems);
  app.post("/api/courier/requests/:requestId/items", requireAuth, controller.assignRequestItems);
  app.post("/api/courier/requests/:requestId/accept", requireAuth, controller.acceptRequest);
  // Dedicated Assignment Writer — the only production
  // route authorized to set courier_requests.assigned_to_user_id. Actor
  // role/region/relationship eligibility is fully re-validated server-side
  // inside CourierService.assignRequest; requireAuth here only proves the
  // caller is an authenticated identity, not that they are authorized to
  // assign anything.
  app.post("/api/courier/requests/:id/assign", requireAuth, controller.assignRequest);
  app.post("/api/courier/requests/:requestId/scan", requireAuth, controller.scanRequestItem);
  app.post("/api/courier/requests/:requestId/confirm-receiving", requireAuth, controller.confirmReceiving);
  app.post("/api/courier/requests/:requestId/start-task", requireAuth, controller.startTask);
  app.post("/api/courier/requests/:requestId/start-route", requireAuth, controller.startRoute);
  app.post("/api/courier/requests/:requestId/arrive-customer", requireAuth, controller.arriveCustomer);
  app.post("/api/courier/requests/:requestId/start-installation", requireAuth, controller.startInstallation);
  app.get("/api/courier/requests/:requestId/execution-attempts", requireAuth, controller.getExecutionAttempts);
  app.post("/api/courier/requests/:requestId/execution-attempts", requireAuth, controller.createExecutionAttempt);

  // Executions (Courier execution forms)
  app.post("/api/courier/executions/:requestId", requireAuth, controller.saveExecution);
  app.post("/api/courier/serial-lookup", requireAuth, controller.serialLookup);

  // Lookups
  app.get("/api/courier/lookups", requireAuth, controller.getLookups);

  // Dashboard & AI statistics
  app.get("/api/courier/dashboard/stats", requireAuth, controller.getDashboardStats);
  app.get("/api/courier/ai-monitor/stats", requireAuth, controller.getAiMonitorStats);

  // Audit logs
  app.get("/api/courier/audit-log", requireAuth, controller.getAuditLogs);

  // PDF Upload & Application
  app.get("/api/courier/pdf", requireAuth, controller.getPdfReports);
  app.get("/api/courier/pdf/:id", requireAuth, controller.getPdfReport);

  // register-drive و complete فقط يقبلان مفتاح الخدمة الداخلي (بوت تيليجرام) -
  // باقي مسارات courier/pdf (المراجعة، apply، reextract) تبقى للواجهة البشرية
  // حصرًا عبر requireAuth.
  //
  // Zero Local Storage hotfix: the old multipart /upload endpoint is
  // decommissioned — it returns 410 Gone immediately, before Multer or any
  // other body-parsing middleware runs, so no file bytes can reach this
  // server via this route under any circumstance.
  app.post("/api/courier/pdf/upload", (_req: Request, res: Response) => {
    res.status(410).json({
      success: false,
      code: "ENDPOINT_GONE",
      message: "Direct file uploads to RASSCO server are permanently decommissioned. Upload the file to Google Drive directly and register its metadata via POST /api/courier/pdf/register-drive.",
    });
  });

  app.post(
    "/api/courier/pdf/register-drive",
    requireJsonContentType,
    requireAuthOrInternal,
    controller.registerDrivePdf,
  );

  app.post("/api/courier/pdf/:id/apply", requireAuth, controller.applyPdf);
  app.post("/api/courier/pdf/:id/complete", requireAuthOrInternal, controller.completePdf);
  app.post("/api/courier/pdf/:id/update-extracted", requireAuthOrInternal, controller.updatePdfExtractedJson);
  app.post("/api/courier/pdf/:id/reextract", requireAuth, controller.reextractPdf);
  app.post("/api/courier/pdf/:id/reject", requireAuth, controller.rejectPdf);
  app.post("/api/courier/serial-lookup", requireAuthOrInternal, controller.serialLookup);
  app.post("/api/courier/sim-link", requireAuthOrInternal, controller.linkSimToTechnician);
}
