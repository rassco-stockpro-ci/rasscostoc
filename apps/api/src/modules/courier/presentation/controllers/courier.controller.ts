import type { Request, Response } from "express";
import { asyncHandler } from "@core/errors/errorHandler";
import { CourierService } from "../../application/courier.service";
import { ValidationError, NotFoundError } from "@core/errors/AppError";
import { ensureDevicesInExtractedJson } from "../../application/ai-engine/courier-pdf-extraction.adapter";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { assignCourierRequestCommandSchema } from "@shared/schema";

// courier_requests.id is a PostgreSQL serial (int4).
// Other route :id parameters in this controller are parsed with a bare
// Number(...) cast, which silently accepts scientific notation, leading
// zeros, and other syntactically-numeric-but-not-canonical forms. The
// Assignment Writer is a security-sensitive write path and is frozen to the
// stricter ASCII-decimal-digits-only lexical contract instead of reusing
// that looser existing convention.
function parseStrictCourierRequestId(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ValidationError("Invalid request ID");
  }
  const id = Number(raw);
  if (id > 2147483647) {
    throw new ValidationError("Invalid request ID");
  }
  return id;
}

/**
 * Hotfix scope: JSON-only registration of a Google Drive-hosted PDF. Zero
 * Local Storage — RASSCO never receives file bytes on this endpoint. Rejects
 * base64/blob/file:// payloads and local paths explicitly rather than just
 * relying on "not a Drive URL" to fail some other way.
 */
const RegisterDrivePdfSchema = z.object({
  drive_url: z
    .string()
    .url()
    .refine((url) => /^https:\/\//i.test(url), {
      message: "drive_url must be an https:// URL",
    })
    .refine((url) => /^https:\/\/(drive|docs)\.google\.com\//i.test(url), {
      message: "drive_url must be a Google Drive URL",
    }),
  file_name: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !name.includes("..") && !name.includes("/") && !name.includes("\\"), {
      message: "file_name must not contain path traversal characters",
    }),
  // Explicitly reject any binary/base64/local-content payload on this JSON-only endpoint.
  file_bytes: z.undefined({ invalid_type_error: "Binary file bytes payload is prohibited on this endpoint" }).optional(),
  base64: z.undefined({ invalid_type_error: "Base64 payload is prohibited on this endpoint" }).optional(),
  content: z.undefined({ invalid_type_error: "Raw file content payload is prohibited on this endpoint" }).optional(),
  buffer: z.undefined({ invalid_type_error: "Buffer payload is prohibited on this endpoint" }).optional(),
});

// OPS-PERM-S0-B1-B.MR1.B1.R1: removes a temporary bulk-import upload file.
// A missing file (ENOENT) is treated as already-cleaned and ignored —
// idempotent, since some other path (e.g. upload-policy's own validation
// failure) may have already removed it. Any OTHER error (EPERM, EACCES,
// EBUSY, disk I/O failure, ...) is a REAL cleanup failure and is thrown,
// never silently swallowed — callers decide what that means for the
// response (see importExcel below).
function removeTempImportFileOrThrow(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
}

export class CourierController {
  constructor(private readonly service: CourierService) {}

  /**
   * Minimal Zero-Storage registration endpoint. JSON only (enforced at the
   * route level before this handler runs). No Multer, no req.file, no
   * Buffer — the file never touches this server, only its Drive URL does.
   */
  registerDrivePdf = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const parsed = RegisterDrivePdfSchema.parse(req.body);

    let driveFileName = parsed.file_name;
    try {
      if (/[\x80-\xFF]/.test(driveFileName)) {
        driveFileName = Buffer.from(driveFileName, "latin1").toString("utf8");
      }
    } catch {}

    const result = await this.service.registerPdfReportFromDriveUrl(
      driveFileName,
      parsed.drive_url,
      user.id,
    );

    res.status(201).json(result);
  });

  getRequests = asyncHandler(async (req: Request, res: Response) => {
    const filters = {
      q: req.query.q as string,
      city: req.query.city as string,
      technician: req.query.technician as string,
      status: req.query.status as string,
      reason: req.query.reason as string,
      simType: req.query.simType as string,
      vendor: req.query.vendor as string,
      priority: req.query.priority as string,
      dateFrom: req.query.dateFrom as string,
      dateTo: req.query.dateTo as string,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 50,
      includeTotal: req.query.includeTotal === "false" ? false : true,
    };
    const t0 = Date.now();
    const result = await this.service.listRequests(filters);
    const apiMs = Date.now() - t0;
    if (result.meta) {
      res.setHeader("X-SQL-Time-Ms", String(result.meta.sqlMs));
      res.setHeader("X-Count-Time-Ms", String(result.meta.countMs));
      res.setHeader("X-Rows-Time-Ms", String(result.meta.rowsMs));
    }
    res.setHeader("X-API-Time-Ms", String(apiMs));
    res.json(result);
  });

  getRequest = asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (isNaN(id)) throw new ValidationError("Invalid request ID");
    const result = await this.service.getRequestById(id);
    if (!result) throw new NotFoundError("Request not found");
    res.json(result);
  });

  createRequest = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    // OPS-PERM-S0-B1-B.I1: actor identity comes exclusively from the
    // authenticated session (req.user), never from req.body.
    const result = await this.service.createRequest(req.body, user.id, {
      role: user.role,
      regionId: user.regionId,
    });
    res.status(201).json(result);
  });

  updateRequest = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const id = Number(req.params.id);
    if (isNaN(id)) throw new ValidationError("Invalid request ID");
    const result = await this.service.updateRequest(id, req.body, user.id);
    if (!result) throw new NotFoundError("Request not found");
    res.json(result);
  });

  deleteRequest = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const id = Number(req.params.id);
    if (isNaN(id)) throw new ValidationError("Invalid request ID");
    const success = await this.service.deleteRequest(id, user.id);
    if (!success) throw new NotFoundError("Request not found");
    res.json({ success: true });
  });

  deleteAllRequests = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const count = await this.service.deleteAllRequests(user.id);
    res.json({ success: true, count, message: `تم حذف ${count} طلب بنجاح.` });
  });

  saveExecution = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = Number(req.params.requestId);
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    const result = await this.service.saveExecution(requestId, req.body, user.id);
    res.json(result);
  });

  getRequestItems = asyncHandler(async (req: Request, res: Response) => {
    const requestId = Number(req.params.requestId);
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    const result = await this.service.getRequestItems(requestId);
    res.json(result);
  });

  assignRequestItems = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = Number(req.params.requestId);
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    if (!Array.isArray(req.body)) throw new ValidationError("Items data must be an array");
    const result = await this.service.assignRequestItems(requestId, req.body, user.id);
    res.status(201).json(result);
  });

  acceptRequest = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = Number(req.params.requestId);
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    const result = await this.service.acceptRequest(requestId, user.id);
    res.json(result);
  });

  // Assignment Writer HTTP entry point. Presentation
  // layer owns only HTTP parsing/validation/mapping here — every
  // authorization and business-eligibility decision happens inside
  // CourierService.assignRequest.
  assignRequest = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = parseStrictCourierRequestId(req.params.id);
    const command = assignCourierRequestCommandSchema.parse(req.body);
    const result = await this.service.assignRequest(requestId, user.id, command);
    res.json(result);
  });

  scanRequestItem = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = Number(req.params.requestId);
    const { serial } = req.body;
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    if (!serial) throw new ValidationError("Serial is required");
    const result = await this.service.scanRequestItem(requestId, serial, user.id);
    res.json(result);
  });

  confirmReceiving = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = Number(req.params.requestId);
    const { itemStatuses, sessionMetadata } = req.body;
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    const result = await this.service.confirmReceiving(requestId, user.id, itemStatuses, sessionMetadata);
    res.json(result);
  });

  startTask = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = Number(req.params.requestId);
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    const result = await this.service.startTask(requestId, user.id);
    res.json(result);
  });

  getLookups = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    // OPS-PERM-S0-B1-B.F1.R1: least-privilege technician-directory scope —
    // actor identity comes exclusively from the authenticated session.
    const result = await this.service.getLookups({ role: user.role, regionId: user.regionId });
    res.json(result);
  });

  getDashboardStats = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.service.getDashboardStats();
    res.json(result);
  });

  getAiMonitorStats = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.service.getAiMonitorStats();
    res.json(result);
  });

  getAuditLogs = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.service.listAuditLogs();
    res.json(result);
  });

  getPdfReports = asyncHandler(async (req: Request, res: Response) => {
    const region = typeof req.query.region === "string" ? req.query.region : undefined;
    const technician = typeof req.query.technician === "string" ? req.query.technician : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const result = await this.service.getPdfReports({ region, technician, q });
    res.json(result);
  });

  uploadPdf = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const file = req.file;
    const requestId = req.body.request_id
      ? Number(req.body.request_id)
      : req.body.requestId
      ? Number(req.body.requestId)
      : undefined;
    const extractedJson = req.body.extracted_json || req.body.extractedJson;
    const overallConfidence =
      req.body.overall_confidence || req.body.overallConfidence
        ? Number(req.body.overall_confidence || req.body.overallConfidence)
        : undefined;

    // \u0628\u0648\u062A \u062A\u064A\u0644\u064A\u062C\u0631\u0627\u0645 (installation_bot.py) \u064A\u0631\u0641\u0639 \u0627\u0644\u0645\u0644\u0641 \u0627\u0644\u0623\u0635\u0644\u064A \u0625\u0644\u0649 Google Drive \u0628\u0646\u0641\u0633\u0647 \u0623\u0648\u0644\u064B\u0627\u060C
    // \u062B\u0645 \u064A\u0645\u0631\u0631 \u0631\u0627\u0628\u0637\u0647 \u0647\u0646\u0627 \u0643\u0646\u0635 \u0639\u0627\u062F\u064A \u0628\u062F\u0644 \u062C\u0633\u0645 multipart - \u0644\u0627 \u0646\u062E\u0632\u0651\u0646 \u0623\u064A \u0646\u0633\u062E\u0629 \u062B\u0627\u0646\u064A\u0629 \u0645\u0646 \u0627\u0644\u0645\u0644\u0641 \u0639\u0644\u0649
    // \u0642\u0631\u0635 \u0627\u0644\u0633\u064A\u0631\u0641\u0631 \u0623\u0648 \u0641\u064A \u0642\u0627\u0639\u062F\u0629 \u0627\u0644\u0628\u064A\u0627\u0646\u0627\u062A\u060C \u0641\u0642\u0637 \u0627\u0644\u0631\u0627\u0628\u0637. \u0647\u0630\u0627 \u0627\u0644\u0641\u0631\u0639 \u0627\u0644\u0648\u062D\u064A\u062F \u0627\u0644\u0630\u064A \u0644\u0627 \u064A\u062A\u0637\u0644\u0628 req.file\u061B
    // \u0645\u0633\u0627\u0631 \u0627\u0644\u0631\u0641\u0639 \u0627\u0644\u0628\u0634\u0631\u064A \u0639\u0628\u0631 \u0648\u0627\u062C\u0647\u0629 \u0627\u0644\u0648\u064A\u0628 (multipart) \u064A\u0628\u0642\u0649 \u0643\u0645\u0627 \u0647\u0648 \u062A\u0645\u0627\u0645\u064B\u0627 \u0641\u064A \u0627\u0644\u0641\u0631\u0639 \u0623\u062F\u0646\u0627\u0647.
    const driveUrl = req.body.drive_url || req.body.driveUrl;
    if (!file && driveUrl) {
      let driveFileName = req.body.file_name || req.body.fileName || "report.pdf";
      try {
      if (/[-ÿ]/.test(driveFileName)) {
          driveFileName = Buffer.from(driveFileName, "latin1").toString("utf8");
        }
      } catch {}

      const result = await this.service.registerPdfReportFromDriveUrl(
        driveFileName,
        String(driveUrl),
        user.id,
        requestId,
        extractedJson,
        overallConfidence
      );

      return res.json(result);
    }

    if (!file) throw new ValidationError("No PDF file uploaded");

    // Fix UTF-8 latin1 filename encoding if necessary
    let fileName = file.originalname;
    try {
      if (/[\u0080-\u00FF]/.test(fileName)) {
        fileName = Buffer.from(fileName, "latin1").toString("utf8");
      }
    } catch {}

    const result = await this.service.uploadPdfReport(
      fileName,
      file.filename, // Using stored multer filename
      file.buffer || Buffer.alloc(0), // If using memoryStorage
      user.id,
      requestId,
      extractedJson,
      overallConfidence
    );

    res.json(result);
  });

  updatePdfExtractedJson = asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (isNaN(id)) throw new ValidationError("Invalid PDF ID");
    const { extracted_json, extractedJson, overall_confidence, overallConfidence, request_id, requestId } = req.body;

    const jsonToUse = extracted_json || extractedJson;
    if (!jsonToUse) throw new ValidationError("extracted_json is required");

    const conf = overall_confidence ?? overallConfidence;
    const reqId = request_id ?? requestId;

    const result = await this.service.updatePdfReportExtractedJson(
      id,
      jsonToUse,
      conf ? Number(conf) : undefined,
      reqId ? Number(reqId) : undefined
    );

    res.json(result);
  });

  reextractPdf = asyncHandler(async (req: Request, res: Response) => {
    const pdfId = Number(req.params.id);
    if (isNaN(pdfId)) throw new ValidationError("Invalid PDF ID");
    const result = await this.service.reextractPdfReport(pdfId);
    res.json(result);
  });

  applyPdf = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const pdfId = Number(req.params.id);
    const requestId = Number(req.body.request_id);

    if (isNaN(pdfId)) throw new ValidationError("Invalid PDF ID");
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");

    const result = await this.service.applyPdfReport(
      pdfId,
      requestId,
      req.body.fields,
      req.body.confidence,
      user.id
    );

    res.json(result);
  });

  /** PR-006A-9 — Complete via saveExecution + CompletionGuard */
  completePdf = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const pdfId = Number(req.params.id);
    const requestId = Number(req.body.request_id);

    if (isNaN(pdfId)) throw new ValidationError("Invalid PDF ID");
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    if (!Array.isArray(req.body.devices)) {
      throw new ValidationError("devices array is required");
    }

    const result = await this.service.completePdfReport(
      pdfId,
      requestId,
      {
        devices: req.body.devices,
        deliveryDate: req.body.deliveryDate ?? req.body.delivery_date ?? null,
        time: req.body.time ?? null,
        paperRoll: req.body.paperRoll ?? req.body.paper_roll ?? "Yes",
        version: req.body.version,
      },
      user.id,
    );

    res.json(result);
  });

  rejectPdf = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const pdfId = Number(req.params.id);
    if (isNaN(pdfId)) throw new ValidationError("Invalid PDF ID");

    const reasonCategory = (req.body.reasonCategory || req.body.reason || "UNCLEAR_PHOTO").toString();
    const notes = (req.body.notes || "").toString();

    const result = await this.service.rejectPdfReport(
      pdfId,
      reasonCategory,
      notes,
      user.id
    );

    res.json(result);
  });

  deletePdfReport = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const pdfId = Number(req.params.id);
    if (!Number.isInteger(pdfId) || pdfId <= 0) throw new ValidationError("Invalid PDF ID");

    const result = await this.service.deletePdfReport(pdfId, user.id);
    res.json({ success: true, ...result });
  });

  claimPdfDeletionTask = asyncHandler(async (_req: Request, res: Response) => {
    const task = await this.service.claimNextPdfDeletionTask();
    res.json({ success: true, task });
  });

  completePdfDeletionTask = asyncHandler(async (req: Request, res: Response) => {
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) throw new ValidationError("Invalid deletion task ID");
    if (typeof req.body?.success !== "boolean") throw new ValidationError("success (boolean) is required");

    const error = typeof req.body.error === "string" ? req.body.error : undefined;
    const task = await this.service.completePdfDeletionTask(taskId, req.body.success, error);
    res.json({ success: true, task });
  });

  getPdfReport = asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (isNaN(id)) throw new ValidationError("Invalid PDF ID");
    const result = await this.service.getPdfReportById(id);
    if (!result) throw new NotFoundError("PDF Report not found");

    if (req.query.raw === "1") {
      const rawPath = result.filePath || "";

      // ملفات مرفوعة عبر البوت مسجّلة برابط Google Drive مباشرة (بدون نسخة على قرص
      // السيرفر) - filePath هنا هو الرابط نفسه لا مسار قرص، فنحوّل المتصفح إليه مباشرة
      // بدل محاولة قراءته من القرص (سيفشل بـ 404 دومًا لأنه غير موجود أصلًا).
      if (/^https?:\/\//i.test(rawPath)) {
        return res.redirect(302, rawPath);
      }

      const basename = path.basename(rawPath);
      const possiblePaths = [
        rawPath,
        path.join(process.cwd(), rawPath),
        path.join(process.cwd(), "uploads", "pdf", basename),
        path.join(process.cwd(), "uploads", "courier-pdf", basename),
        path.join(process.cwd(), "uploads", basename),
        path.join(process.cwd(), "uploads", "pdf", rawPath),
      ];

      const foundPath = possiblePaths.find(p => p && fs.existsSync(p));
      if (!foundPath) {
        throw new NotFoundError(`File not found on disk: ${result.fileName}`);
      }

      const buffer = fs.readFileSync(foundPath);
      const ext = path.extname(result.fileName || rawPath).toLowerCase();
      let contentType = "application/pdf";
      if (ext === ".png") contentType = "image/png";
      else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
      else if (ext === ".webp") contentType = "image/webp";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(result.fileName || basename)}"`);
      return res.send(buffer);
    }

    res.json({
      ...result,
      extractedJson: ensureDevicesInExtractedJson(
        JSON.parse(result.extractedJson || "{}"),
      ),
    });
  });

  importExcel = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const file = req.file;
    if (!file) throw new ValidationError("No Excel file uploaded");

    // OPS-PERM-S0-B1-B.MR1.B1.R2: the temporary disk file is read into
    // memory and then REMOVED BEFORE any business logic runs — not after.
    // An earlier version cleaned up only after service.importRawRequests()
    // had already completed (successfully or not), which meant a rare
    // disk-cleanup failure occurring AFTER a successful import could still
    // reach the client as a failure response, even though the batch had
    // already been persisted. That is exactly the ambiguous-outcome
    // problem RFC 9110 warns about for a non-idempotent POST: the caller
    // cannot tell whether retrying would duplicate the import or not.
    // Once `buffer` holds the bytes, the disk file serves no further
    // purpose — removing it here means a cleanup failure aborts the
    // request BEFORE the service (and therefore before any database
    // mutation) is ever invoked. No temp file exists anywhere during
    // service.importRawRequests()'s execution.
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(file.path);
    } catch (readError) {
      try {
        removeTempImportFileOrThrow(file.path);
      } catch (cleanupError) {
        // A cleanup failure here never replaces the read error — it is
        // only logged for operational visibility.
        console.error(
          "[CourierController.importExcel] temp file cleanup failed after a read error " +
            "(the read error below is still the one propagated to the client)",
          { path: file.path, cleanupError }
        );
      }
      throw readError;
    }

    // The read succeeded — remove the temp file now, BEFORE calling the
    // service. If this throws, the service is never called and no
    // business mutation occurs; the cleanup error itself is what
    // propagates (never a false success).
    removeTempImportFileOrThrow(file.path);

    // OPS-PERM-S0-B1-B.I1: targetRegionId travels alongside the file as a
    // normal multipart form field — validated server-side (Admin-only,
    // active-region check) inside importRawRequests, never trusted as-is.
    const result = await this.service.importRawRequests(
      buffer,
      user.id,
      { role: user.role, regionId: user.regionId },
      req.body?.targetRegionId,
    );
    res.json(result);
  });

  exportExcel = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const filters = {
      q: req.query.q as string,
      city: req.query.city as string,
      technician: req.query.technician as string,
      status: req.query.status as string,
      reason: req.query.reason as string,
      simType: req.query.simType as string,
      vendor: req.query.vendor as string,
      priority: req.query.priority as string,
      dateFrom: req.query.dateFrom as string,
      dateTo: req.query.dateTo as string
    };

    const count = await this.service.countRequests(filters);

    if (count > 10000) {
      const { jobsRepository } = await import("@core/jobs/jobs.repository");
      const jobId = await jobsRepository.createJob({
        type: "EXPORT_EXCEL",
        ownerId: user.id,
        payload: JSON.stringify({ filters }),
      });
      return res.status(202).json({
        async: true,
        jobId,
        message: "تم بدء عملية تصدير البيانات في الخلفية نظراً لكبر حجم البيانات المطلوب تصديرها. يمكنك تتبع حالة العملية وتنزيل الملف عند اكتمالها.",
      });
    }

    const buffer = await this.service.exportRequests(filters);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="neoleap-export-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  });

  startRoute = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = Number(req.params.requestId);
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    const result = await this.service.startRoute(requestId, user.id);
    res.json(result);
  });

  arriveCustomer = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = Number(req.params.requestId);
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    const result = await this.service.arriveCustomer(requestId, user.id);
    res.json(result);
  });

  startInstallation = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = Number(req.params.requestId);
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    const result = await this.service.startInstallation(requestId, user.id);
    res.json(result);
  });

  getExecutionAttempts = asyncHandler(async (req: Request, res: Response) => {
    const requestId = Number(req.params.requestId);
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    const result = await this.service.getExecutionAttempts(requestId);
    res.json(result);
  });

  createExecutionAttempt = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const requestId = Number(req.params.requestId);
    if (isNaN(requestId)) throw new ValidationError("Invalid request ID");
    const result = await this.service.createExecutionAttempt(requestId, user.id, req.body);
    res.status(201).json(result);
  });

  serialLookup = asyncHandler(async (req: Request, res: Response) => {
    const { sn, serial } = req.body;
    const term = (sn || serial || "").toString().trim();
    if (!term) throw new ValidationError("sn is required");
    const result = await this.service.serialLookup(term);
    res.json(result);
  });

  linkSimToTechnician = asyncHandler(async (req: Request, res: Response) => {
    const { simSerial, sim_serial, simType, sim_type, technicianId, technician_id, technicianUsername, technician_code, notes } = req.body;
    const serial = (simSerial || sim_serial || "").toString().trim();
    if (!serial) throw new ValidationError("simSerial is required");

    const result = await this.service.linkSimToTechnician({
      simSerial: serial,
      simType: simType || sim_type || "STC",
      technicianId: technicianId || technician_id,
      technicianUsername: technicianUsername || technician_code,
      notes,
    });

    res.json(result);
  });
}
