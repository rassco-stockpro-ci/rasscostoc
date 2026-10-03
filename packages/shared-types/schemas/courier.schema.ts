import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, serial, real, uuid, jsonb, doublePrecision, index, primaryKey, unique, uniqueIndex, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./organization.schema";
import { regions } from "./catalog.schema";
import { items } from "./serialized_items.schema";

// 1. Cities
export const courierCities = pgTable("courier_cities", {
  id: serial("id").primaryKey(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
});

// 2. SIM Types
export const courierSimTypes = pgTable("courier_sim_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
});

// 3. Vendor Types
export const courierVendorTypes = pgTable("courier_vendor_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
});

// 4. Failure Reasons
export const courierFailureReasons = pgTable("courier_failure_reasons", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  labelEn: text("label_en").notNull(),
  labelAr: text("label_ar").notNull(),
  suggestedNoteEn: text("suggested_note_en"),
  suggestedNoteAr: text("suggested_note_ar"),
  requiresField: text("requires_field"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

// 5. Courier Requests (Orders)
export const courierRequests = pgTable("courier_requests", {
  id: serial("id").primaryKey(),
  date: text("date"),
  installationType: text("installation_type"),
  sim: text("sim"),
  tid: text("tid"),
  otp: text("otp"),
  ticketingHolouly: text("ticketing_holouly"),
  incidentNumber: text("incident_number"),
  pinCode: text("pin_code"),
  trsm: text("trsm"),
  terminalId: text("terminal_id"),
  simSn: text("sim_sn"),
  idData: text("id_data"),
  vendorType: text("vendor_type"),
  city: text("city"),
  cityTec: text("city_tec"),
  customerName: text("customer_name"),
  retailerName: text("retailer_name"),
  addressAr: text("address_ar"),
  addressEn: text("address_en"),
  mobile: text("mobile"),
  mobile2: text("mobile2"),
  tecName: text("tec_name"),
  createdBy: varchar("created_by").references(() => users.id),
  // OPS-PERM-S0-B1-A.I1 / OPS-PERM-S0-B1-B.I1: canonical operational
  // regional OWNERSHIP — explicitly NOT derived from createdBy (creator),
  // execution.enteredBy (mutable/reassignable executor), or the free-text
  // city/cityTec columns above. Nullable (legacy rows intentionally remain
  // unresolved, never guessed/backfilled — see OPS-PERM-S0-B1.D1). Assigned
  // ONLY by courier.service.ts's server-side region-assignment contract
  // (createRequest/importRawRequests) — never accepted directly from a
  // client body; see insertCourierRequestSchema's explicit omission below.
  // Immutable-after-create: never updatable via the general
  // PUT /requests/:id path (independently enforced at both the service and
  // repository layers).
  regionId: varchar("region_id").references(() => regions.id),
  // Canonical CURRENT FIELD ASSIGNEE — the single authoritative answer to
  // "which Courier/Technician user is this request currently assigned to".
  // Explicitly NOT derived from and NOT a substitute for any of:
  // courierRequestItems.technicianId (records who scanned an item, not who
  // is assigned), courierExecutions.enteredBy (records who performed the
  // last lifecycle action, rewritten by every step, never a stable owner),
  // courierExecutions.salesTechnician/technicianCode (free-text report
  // labels, no FK), or items.currentOwnerId (physical inventory custody,
  // unrelated to request-level assignment). None of these qualify as an
  // assignment authority because each records a transient action or an
  // unrelated concept, not a persisted, stable current-assignee state.
  //
  // Cardinality: 0..1 — a request has at most one current assignee. NULL
  // means UNASSIGNED; it must never be interpreted as "assigned to every
  // technician", "assigned to whoever is in the request's region", or
  // "assigned to the last actor". No legacy row is backfilled with a
  // guessed value — an unknown assignment stays unknown rather than being
  // inferred.
  //
  // Reassignment is a deliberate, separately-authorized write operation —
  // it is never set implicitly by a Courier/Technician calling a lifecycle
  // endpoint (accept/scan/start/etc.). Server-controlled only: explicitly
  // omitted from insertCourierRequestSchema below and from the general
  // update's persistence allowlist — a client can never set or change this
  // value directly.
  assignedToUserId: varchar("assigned_to_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  version: integer("version").default(1).notNull(),
}, (table) => ({
  // ERP-001 Package A — list/filter/search indexes
  courierRequestsTidIdx: index("courier_requests_tid_idx").on(table.tid),
  courierRequestsTerminalIdIdx: index("courier_requests_terminal_id_idx").on(table.terminalId),
  courierRequestsIncidentIdx: index("courier_requests_incident_number_idx").on(table.incidentNumber),
  courierRequestsMobileIdx: index("courier_requests_mobile_idx").on(table.mobile),
  courierRequestsDateIdx: index("courier_requests_date_idx").on(table.date),
  courierRequestsCityIdx: index("courier_requests_city_idx").on(table.city),
  courierRequestsCustomerNameIdx: index("courier_requests_customer_name_idx").on(table.customerName),
  courierRequestsVendorTypeIdx: index("courier_requests_vendor_type_idx").on(table.vendorType),
  // OPS-PERM-S0-B1-A.I1: matches listRequests'/exportExcel's own existing
  // ORDER BY desc(courierRequests.id) — the dominant future query shape.
  courierRequestsRegionIdIdx: index("courier_requests_region_id_idx").on(table.regionId, table.id.desc()),
}));

// 5.5. Courier Request Items
export const courierRequestItems = pgTable("courier_request_items", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").notNull().references(() => courierRequests.id, { onDelete: 'cascade' }),
  itemType: text("item_type").notNull(), // 'POS', 'SIM', 'ACCESSORY', etc.
  // Legacy, dead: integer while items.id is a varchar UUID. Superseded by
  // itemId (migration 0060); kept untouched during the transition period.
  inventoryItemId: integer("inventory_item_id"),
  /** The inventory item this row stands for (migration 0060). */
  itemId: varchar("item_id").references(() => items.id, { onDelete: "restrict" }),
  serialNumber: text("serial_number"),
  simSerial: text("sim_serial"),
  quantity: integer("quantity").notNull().default(1),
  status: text("status").notNull().default("PENDING_RECEIPT"), // PENDING_RECEIPT, RECEIVED, INSTALLED, DELIVERED, REJECTED, MISSING
  scannedAt: timestamp("scanned_at"),
  receivedAt: timestamp("received_at"),
  installedAt: timestamp("installed_at"),
  deliveredAt: timestamp("delivered_at"),
  technicianId: varchar("technician_id").references(() => users.id),
  /** The installation unit this item was installed in (set with INSTALLED; migration 0060). */
  executionUnitId: integer("execution_unit_id").references((): any => courierExecutionUnits.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  courierRequestItemsRequestIdx: index("courier_request_items_request_idx").on(table.requestId),
  courierRequestItemsExecutionUnitIdx: index("courier_request_items_execution_unit_idx").on(table.executionUnitId),
}));

// 6. Courier Executions
export const courierExecutions = pgTable("courier_executions", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").notNull().unique().references(() => courierRequests.id, { onDelete: 'cascade' }),
  requestPriorityLevel: text("request_priority_level"),
  pushBack: text("push_back"),
  installationStatus: text("installation_status"),
  paperRoll: text("paper_roll"),
  paperRollQty: integer("paper_roll_qty").default(0),
  stickersQty: integer("stickers_qty").default(0),
  nulipCardsQty: integer("nulip_cards_qty").default(0),
  time: text("time"),
  deliveryDate: text("delivery_date"),
  responseDate: text("response_date"),
  sn: text("sn"),
  simSerial: text("sim_serial"),
  simType: text("sim_type"),
  customerNotes: text("customer_notes"),
  extraField1: text("extra_field_1"),
  extraField2: text("extra_field_2"),
  responseReasonCode: text("response_reason_code").references(() => courierFailureReasons.code),
  salesTechnician: text("sales_technician"),
  technicianCode: text("technician_code"),
  extractionConfidence: text("extraction_confidence"),
  enteredBy: varchar("entered_by").references(() => users.id),
  enteredAt: timestamp("entered_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  version: integer("version").default(1).notNull(),
  // OPS-REMED-E4-P4: NOT NULL + allowed-value CHECK constraint, staged
  // across migrations 0052-0054 (NOT VALID add -> VALIDATE -> SET NOT
  // NULL), enforced in the database as
  // courier_executions_custody_closure_status_check. Every writer
  // (courier.service.ts initial insert, inventory.subscriber.ts,
  // CourierProjectionWorker.ts, courier-saga.subscriber.ts, and the
  // one-time legacy backfill script) writes only these six values:
  // PENDING_DEDUCTION, PROCESSING, CLOSED_SUCCESS, FAILED_RETRYABLE,
  // FAILED_FINAL, RECONCILIATION_REQUIRED.
  custodyClosureStatus: text("custody_closure_status").notNull(),
}, (table) => ({
  // ERP-001 Package A — list/filter/search indexes
  courierExecutionsSnIdx: index("courier_executions_sn_idx").on(table.sn),
  courierExecutionsSimSerialIdx: index("courier_executions_sim_serial_idx").on(table.simSerial),
  courierExecutionsStatusIdx: index("courier_executions_installation_status_idx").on(table.installationStatus),
  courierExecutionsTechIdx: index("courier_executions_sales_technician_idx").on(table.salesTechnician),
  courierExecutionsReasonIdx: index("courier_executions_response_reason_idx").on(table.responseReasonCode),
  courierExecutionsSimTypeIdx: index("courier_executions_sim_type_idx").on(table.simType),
  courierExecutionsPriorityIdx: index("courier_executions_priority_idx").on(table.requestPriorityLevel),
}));

// 6.1. Courier Execution Units (migration 0060) — one row per installed
// terminal of a close: exactly one device, at most one SIM (or an explicit
// waiver), optional TID. The unit IS the Device<->SIM pairing. Written only
// inside the close transaction (CloseRequestUseCase.commit), never updated.
export const EXECUTION_UNIT_PAIRING_SOURCES = ["EXPLICIT", "LEGACY_INFERRED", "LEGACY_BACKFILL"] as const;
export type ExecutionUnitPairingSource = (typeof EXECUTION_UNIT_PAIRING_SOURCES)[number];

export const courierExecutionUnits = pgTable("courier_execution_units", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").notNull().references(() => courierRequests.id, { onDelete: "cascade" }),
  executionId: integer("execution_id").notNull().references(() => courierExecutions.id, { onDelete: "cascade" }),
  unitNo: integer("unit_no").notNull(),
  deviceItemId: varchar("device_item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  deviceSerial: text("device_serial").notNull(),
  simItemId: varchar("sim_item_id").references(() => items.id, { onDelete: "restrict" }),
  simSerial: text("sim_serial"),
  simWaived: boolean("sim_waived").notNull().default(false),
  tid: text("tid"),
  pairingSource: text("pairing_source").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  requestUnitNoUq: unique("courier_execution_units_request_unit_no_uq").on(table.requestId, table.unitNo),
  requestDeviceUq: unique("courier_execution_units_request_device_uq").on(table.requestId, table.deviceItemId),
  requestSimUq: uniqueIndex("courier_execution_units_request_sim_uq").on(table.requestId, table.simItemId).where(sql`${table.simItemId} IS NOT NULL`),
  executionIdx: index("courier_execution_units_execution_idx").on(table.executionId),
  deviceSerialIdx: index("courier_execution_units_device_serial_idx").on(table.deviceSerial),
  simSerialIdx: index("courier_execution_units_sim_serial_idx").on(table.simSerial),
  unitNoPositive: check("courier_execution_units_unit_no_positive_check", sql`${table.unitNo} >= 1`),
  pairingSourceCheck: check(
    "courier_execution_units_pairing_source_check",
    sql`${table.pairingSource} IN ('EXPLICIT', 'LEGACY_INFERRED', 'LEGACY_BACKFILL')`
  ),
  simConsistency: check(
    "courier_execution_units_sim_consistency_check",
    sql`(${table.simItemId} IS NULL AND ${table.simSerial} IS NULL AND ${table.simWaived}) OR (${table.simItemId} IS NOT NULL AND ${table.simSerial} IS NOT NULL AND NOT ${table.simWaived})`
  ),
  deviceNeSim: check("courier_execution_units_device_ne_sim_check", sql`${table.simItemId} IS NULL OR ${table.simItemId} <> ${table.deviceItemId}`),
}));

export type CourierExecutionUnitRow = typeof courierExecutionUnits.$inferSelect;
export type InsertCourierExecutionUnit = typeof courierExecutionUnits.$inferInsert;

// 7. PDF Reports
export const courierPdfReports = pgTable("courier_pdf_reports", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").references(() => courierRequests.id, { onDelete: 'set null' }),
  fileName: text("file_name").notNull(),
  filePath: text("file_path").notNull(),
  uploadedBy: varchar("uploaded_by").references(() => users.id),
  uploadedAt: timestamp("uploaded_at").defaultNow(),
  ocrText: text("ocr_text"),
  extractedJson: text("extracted_json"),
  overallConfidence: real("overall_confidence"),
  status: text("status").notNull().default("pending"),
});

// 7b. PDF Report Deletion Tasks - see migrations/0065_courier_pdf_deletion_tasks_add.sql.
// No FK to courierPdfReports.id: the report row this task was created for is deleted in the
// same transaction that inserts this row (see CourierService.deletePdfReport).
export const courierPdfDeletionTasks = pgTable("courier_pdf_deletion_tasks", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id").notNull(),
  driveUrl: text("drive_url"),
  fileName: text("file_name"),
  requestedBy: varchar("requested_by").references(() => users.id),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
  status: text("status").notNull().default("PENDING"),
  attempts: integer("attempts").notNull().default(0),
  leasedUntil: timestamp("leased_until"),
  completedAt: timestamp("completed_at"),
  lastError: text("last_error"),
}, (table) => ({
  statusIdx: index("courier_pdf_deletion_tasks_status_idx").on(table.status),
  statusCheck: check(
    "courier_pdf_deletion_tasks_status_check",
    sql`${table.status} IN ('PENDING', 'CLAIMED', 'DONE', 'FAILED')`
  ),
}));

// 8. Courier Audit Logs
export const courierAuditLogs = pgTable("courier_audit_logs", {
  id: serial("id").primaryKey(),
  tableName: text("table_name").notNull(),
  recordId: integer("record_id").notNull(),
  fieldName: text("field_name"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  action: text("action").notNull(),
  // Actor identity snapshot — kept alongside changedBy so historical log
  // entries still display the acting user's name/role/avatar even if the
  // user account is later renamed or deleted.
  actorNameSnapshot: text("actor_name_snapshot"),
  actorRoleSnapshot: text("actor_role_snapshot"),
  actorAvatarUrl: text("actor_avatar_url"),
  actionType: text("action_type").notNull().default("UPDATE"),
  actionDescription: text("action_description"),
  source: text("source").notNull().default("DASHBOARD"),
  status: text("status").notNull().default("SUCCESS"),
  metadata: jsonb("metadata"),
  ipAddress: text("ip_address"),
  deviceId: text("device_id"),
  changedBy: varchar("changed_by").references(() => users.id),
  changedAt: timestamp("changed_at").defaultNow(),
});

// Zod schemas for validation
export const insertCourierCitySchema = createInsertSchema(courierCities);
export const insertCourierSimTypeSchema = createInsertSchema(courierSimTypes);
export const insertCourierVendorTypeSchema = createInsertSchema(courierVendorTypes);
export const insertCourierFailureReasonSchema = createInsertSchema(courierFailureReasons);
// OPS-PERM-S0-B1-B.I1: regionId is explicitly omitted from the CLIENT-FACING
// insert schema — it is never a valid input field for this exported schema,
// regardless of whether any current caller uses it. Server-side region
// assignment (courier.service.ts) sets it separately, after this schema's
// validation, from the authenticated actor's own identity/an admin-supplied
// targetRegionId — never from a field named regionId/region_id in the body.
//
// assignedToUserId is likewise intentionally absent from this client-facing
// schema — a client body field named assignedToUserId/assigned_to_user_id
// must never be able to set who a request is assigned to at create time.
// This omission is a type/contract-level safeguard shared with any consumer
// of this schema; the actual enforcement on the create/update HTTP paths is
// the explicit strip in courier.service.ts (see createRequest/updateRequest)
// and CourierRequestMapper.toPersistence's allowlist — every request
// persists assignedToUserId = NULL regardless of request body content,
// until a dedicated, separately authorized assignment operation sets it.
export const insertCourierRequestSchema = createInsertSchema(courierRequests).omit({ id: true, createdAt: true, updatedAt: true, regionId: true, assignedToUserId: true });
export const insertCourierExecutionSchema = createInsertSchema(courierExecutions).omit({ id: true, enteredAt: true, updatedAt: true });
export const insertCourierPdfReportSchema = createInsertSchema(courierPdfReports).omit({ id: true, uploadedAt: true });
export const insertCourierAuditLogSchema = createInsertSchema(courierAuditLogs).omit({ id: true, changedAt: true });

// Strict command contract for the dedicated Assignment
// Writer endpoint (POST /api/courier/requests/:id/assign). Unlike
// insertCourierRequestSchema above (which silently strips unknown keys and
// is never meant to carry assignment authority), this schema uses
// `.strict()` so any unexpected key — including authorization-relevant
// fields a caller might try to smuggle in (actorId, role, regionId,
// warehouseId, permissions, or the snake_case assigned_to_user_id) — fails
// validation with a 400 instead of being silently dropped.
//
// assignedToUserId is a REFERENCE to an existing user identity, not a
// new-identity creation field: users.id storage is a legacy-compatible
// unbounded varchar (some rows may predate the current UUID-generation
// default), so this field cannot yet be constrained to UUID format without
// risking rejection of a technician whose id predates that convention. The
// max(128) bound is an explicit Owner-selected compatibility ceiling for
// this reference boundary, not a value derived from the database column
// (which has no declared length) or from a UUID-format assumption.
//
// Passing this schema is never sufficient authorization by itself — the
// supplied assignedToUserId must still resolve, inside the same
// transaction, to a locked, currently-active technician satisfying every
// role/region/relationship requirement enforced by
// CourierService.assignRequest.
export const assignCourierRequestCommandSchema = z.object({
  assignedToUserId: z.string().min(1).max(128),
  version: z.number().int().positive().max(2147483647),
}).strict();

export type AssignCourierRequestCommand = z.infer<typeof assignCourierRequestCommandSchema>;

// 9. Outbox Events Table
export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventName: varchar("event_name", { length: 200 }).notNull(),
  eventVersion: integer("event_version").notNull().default(1),
  payload: jsonb("payload").notNull(),
  correlationId: uuid("correlation_id").notNull(),
  causationId: uuid("causation_id").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("PENDING"), // PENDING, PROCESSING, PUBLISHED, FAILED, DEAD
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
  lastError: text("last_error"),
  lockedBy: varchar("locked_by", { length: 100 }),
  lockedAt: timestamp("locked_at"),
});

export const insertOutboxEventSchema = createInsertSchema(outboxEvents);

// 10. Idempotency Records Table
export const idempotencyRecords = pgTable("idempotency_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).unique().notNull(),
  eventId: uuid("event_id").notNull(),
  subscriberName: varchar("subscriber_name", { length: 100 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(), // PROCESSING, COMPLETED, FAILED
  responsePayload: jsonb("response_payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export const insertIdempotencyRecordSchema = createInsertSchema(idempotencyRecords);
export const insertCourierRequestItemSchema = createInsertSchema(courierRequestItems).omit({ id: true, createdAt: true, updatedAt: true });

// 11. Courier Execution Attempts (Field Visits)
export const courierExecutionAttempts = pgTable("courier_execution_attempts", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").notNull().references(() => courierRequests.id, { onDelete: 'cascade' }),
  attemptNumber: integer("attempt_number").notNull().default(1),
  status: text("status").notNull(), // 'SUCCESS', 'FAILED'
  failureReasonCode: text("failure_reason_code").references(() => courierFailureReasons.code),
  notes: text("notes"),
  snInstalled: text("sn_installed"),
  simInstalled: text("sim_installed"),
  gpsLatitude: doublePrecision("gps_latitude"),
  gpsLongitude: doublePrecision("gps_longitude"),
  batteryLevel: integer("battery_level"),
  networkOperator: text("network_operator"),
  startTime: timestamp("start_time"),
  arrivalTime: timestamp("arrival_time"),
  endTime: timestamp("end_time"),
  evidencePhotos: jsonb("evidence_photos"), // string array
  customerSignature: text("customer_signature"), // Base64
  enteredBy: varchar("entered_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCourierExecutionAttemptSchema = createInsertSchema(courierExecutionAttempts).omit({ id: true, createdAt: true });

export type CourierCity = typeof courierCities.$inferSelect;
export type CourierSimType = typeof courierSimTypes.$inferSelect;
export type CourierVendorType = typeof courierVendorTypes.$inferSelect;
export type CourierFailureReason = typeof courierFailureReasons.$inferSelect;
export type CourierRequest = typeof courierRequests.$inferSelect;
export type CourierRequestItem = typeof courierRequestItems.$inferSelect;
export type CourierExecution = typeof courierExecutions.$inferSelect;
export type CourierPdfReport = typeof courierPdfReports.$inferSelect;
export type CourierPdfDeletionTask = typeof courierPdfDeletionTasks.$inferSelect;
export type CourierAuditLog = typeof courierAuditLogs.$inferSelect;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
export type CourierExecutionAttempt = typeof courierExecutionAttempts.$inferSelect;
export type NewCourierExecutionAttempt = typeof courierExecutionAttempts.$inferInsert;

// OPS-REMED-E4-P2: deduplication for the atomic dedup+state-transition+audit
// operation owned by courier-saga.subscriber.ts. Composite key by
// (source_event_id, operation_kind) — NOT source_event_id alone — so a
// FINAL_FAILURE delivery and a later SUCCESS_PROJECTION correction for the
// SAME original event never collide (A.9 §4 real gap, closed).
export const courierExecutionAuditDedup = pgTable("courier_execution_audit_dedup", {
  sourceEventId: varchar("source_event_id").notNull(),
  operationKind: text("operation_kind").notNull(),
  eventName: varchar("event_name").notNull(),
  processedAt: timestamp("processed_at").notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.sourceEventId, table.operationKind] }),
}));

export type CourierExecutionAuditDedup = typeof courierExecutionAuditDedup.$inferSelect;



