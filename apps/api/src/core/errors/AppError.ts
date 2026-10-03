/**
 * Custom error classes for better error handling
 */

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  /** Optional machine-readable code surfaced to API clients alongside `message`. */
  public readonly code?: string;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;

    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends AppError {
  public readonly errors: any[];

  constructor(message: string, errors: any[] = []) {
    super(message, 400);
    this.errors = errors;
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = "Authentication required") {
    super(message, 401);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = "Insufficient permissions") {
    super(message, 403);
    this.name = 'AuthorizationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found") {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string = "Resource conflict") {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

export class IdempotencyCollisionError extends AppError {
  constructor(message: string = "Request with this idempotency key is already processed or in progress") {
    super(message, 409);
    this.name = 'IdempotencyCollisionError';
  }
}

export class InsufficientStockError extends AppError {
  constructor(message: string = "Insufficient stock balance") {
    super(message, 400);
    this.name = 'InsufficientStockError';
  }
}

export class ProductNotFoundError extends AppError {
  constructor(message: string = "Product not found") {
    super(message, 404);
    this.name = 'ProductNotFoundError';
  }
}

/**
 * DB-R10C.2: thrown when a client-submitted financial value (unit price,
 * amount before tax, tax amount, or total amount) does not match the
 * value the server derived authoritatively from product data. The
 * client-submitted value is never trusted as truth — this error signals
 * that the client's view of the price/tax is stale or has been tampered
 * with, not that anything was corrected silently.
 */
export class FinancialMismatchError extends ConflictError {
  public readonly field: string;
  public readonly expected: string;
  public readonly received: string;

  constructor(field: string, expected: string, received: string) {
    super(
      `Financial value mismatch on field "${field}": server-derived value is ${expected}, client submitted ${received}. ` +
        `The server is the authoritative source of truth for this value and does not accept client-supplied overrides.`
    );
    this.field = field;
    this.expected = expected;
    this.received = received;
    this.name = "FinancialMismatchError";
  }
}

/**
 * DB-R10C.2: thrown when a product's stored `defaultTaxRate` cannot be
 * classified as either the canonical fractional representation (0.15 =
 * 15%) or a recognized legacy percentage-points value (see
 * `classifyLegacyTaxRate` in @core/finance/taxRate) — e.g. negative,
 * over 100, or non-finite. This is a data-integrity problem with stored
 * product configuration, not a client input error, so it is NOT a 4xx
 * client error: it fails closed rather than silently guessing or
 * defaulting to a rate that was never actually configured.
 */
export class InvalidProductTaxConfigurationError extends AppError {
  constructor(productId: string, reason: string) {
    super(
      `Product ${productId} has an invalid or ambiguous stored tax rate (${reason}) and cannot be sold until its tax configuration is corrected.`,
      500,
      true,
      "INVALID_PRODUCT_TAX_CONFIGURATION"
    );
    this.name = "InvalidProductTaxConfigurationError";
  }
}

/**
 * OPS-REMED-E12: thrown when `claimPdfReportForTransition` finds a
 * `pdf_reports` row whose status is no longer the expected one (i.e. the
 * atomic `UPDATE ... WHERE status = $expected` affected zero rows) —
 * another concurrent approval, rejection, or a prior successful completion
 * already transitioned this exact report. The losing request must receive
 * this structured 409 instead of a generic 400 or a raw database error.
 */
export class PdfReportAlreadyProcessedError extends AppError {
  public readonly pdfId: number;

  constructor(pdfId: number) {
    super(
      `تعارض اعتماد: تقرير رقم ${pdfId} تمت معالجته بالفعل (اعتماد أو رفض) بواسطة طلب آخر متزامن.`,
      409,
      true,
      "PDF_REPORT_ALREADY_PROCESSED"
    );
    this.pdfId = pdfId;
    this.name = "PdfReportAlreadyProcessedError";
  }
}

/**
 * OPS-REMED-E12: thrown when `insertExecution` fails with a PostgreSQL
 * unique-violation (23505) on constraint `courier_executions_request_id_unique`
 * specifically — meaning a DIFFERENT pdf_reports row, approved concurrently,
 * already created (or is creating) the execution row for the same
 * requestId. Never thrown for any other constraint or error code; those
 * remain raw technical failures.
 */
export class DuplicateRequestApprovalError extends AppError {
  public readonly requestId: number;

  constructor(requestId: number) {
    super(
      `تعارض اعتماد: يوجد تنفيذ آخر بالفعل للطلب رقم ${requestId} — تم إنشاؤه بواسطة تقرير آخر تمت معالجته بالتزامن.`,
      409,
      true,
      "DUPLICATE_REQUEST_APPROVAL"
    );
    this.requestId = requestId;
    this.name = "DuplicateRequestApprovalError";
  }
}

/**
 * CloseReportIdentityGuard: thrown when a PDF-report completion (completePdfReport,
 * POST /api/courier/pdf/:id/complete) is refused before any write because the report's claimed
 * customer name or request number does not match the request actually being closed. `code`
 * identifies exactly which check failed, so the client (and tests) never have to parse `message`.
 *
 * Deliberately NOT a date/time check: RASSCO has no trusted source for the installation/visit
 * date or time (see receipt-datetime-extraction.ts and CloseReportIdentityGuard) — that match
 * status is UNVERIFIED, not enforced, and this error is never thrown for it.
 */
export class ReportIdentityMismatchError extends AppError {
  constructor(code: "CUSTOMER_MISMATCH" | "REQUEST_NUMBER_MISMATCH", message: string) {
    super(message, 422, true, code);
    this.name = "ReportIdentityMismatchError";
  }
}

export class OptimisticLockException extends ConflictError {
  public readonly tableName: string;
  public readonly recordId: string | number;
  public readonly expectedVersion?: number;
  public readonly actualVersion?: number;

  constructor(
    tableName: string,
    recordId: string | number,
    expectedVersion?: number,
    actualVersion?: number
  ) {
    const msg = `تعديل متزامن مرفوض: تم تعديل السجل رقم ${recordId} في جدول ${tableName} بواسطة مستخدم آخر. النسخة المتوقعة: ${expectedVersion ?? "N/A"}، النسخة الفعلية: ${actualVersion ?? "N/A"}.`;
    super(msg);
    this.tableName = tableName;
    this.recordId = recordId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
    this.name = 'OptimisticLockException';
  }
}

