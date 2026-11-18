import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, serial, real, uuid, jsonb, doublePrecision, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./organization.schema";

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
}));

// 5.5. Courier Request Items
export const courierRequestItems = pgTable("courier_request_items", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").notNull().references(() => courierRequests.id, { onDelete: 'cascade' }),
  itemType: text("item_type").notNull(), // 'POS', 'SIM', 'ACCESSORY', etc.
  inventoryItemId: integer("inventory_item_id"),
  serialNumber: text("serial_number"),
  simSerial: text("sim_serial"),
  quantity: integer("quantity").notNull().default(1),
  status: text("status").notNull().default("PENDING_RECEIPT"), // PENDING_RECEIPT, RECEIVED, INSTALLED, DELIVERED, REJECTED, MISSING
  scannedAt: timestamp("scanned_at"),
  receivedAt: timestamp("received_at"),
  installedAt: timestamp("installed_at"),
  deliveredAt: timestamp("delivered_at"),
  technicianId: varchar("technician_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

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

// 8. Courier Audit Logs
export const courierAuditLogs = pgTable("courier_audit_logs", {
  id: serial("id").primaryKey(),
  tableName: text("table_name").notNull(),
  recordId: integer("record_id").notNull(),
  fieldName: text("field_name"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  action: text("action").notNull(),
  actionType: text("action_type"),
  actionDescription: text("action_description"),
  source: text("source"),
  status: text("status"),
  metadata: jsonb("metadata"),
  actorNameSnapshot: text("actor_name_snapshot"),
  actorRoleSnapshot: text("actor_role_snapshot"),
  actorAvatarUrl: text("actor_avatar_url"),
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
export const insertCourierRequestSchema = createInsertSchema(courierRequests).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCourierExecutionSchema = createInsertSchema(courierExecutions).omit({ id: true, enteredAt: true, updatedAt: true });
export const insertCourierPdfReportSchema = createInsertSchema(courierPdfReports).omit({ id: true, uploadedAt: true });
export const insertCourierAuditLogSchema = createInsertSchema(courierAuditLogs).omit({ id: true, changedAt: true });

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
export type CourierAuditLog = typeof courierAuditLogs.$inferSelect;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
export type CourierExecutionAttempt = typeof courierExecutionAttempts.$inferSelect;
export type NewCourierExecutionAttempt = typeof courierExecutionAttempts.$inferInsert;



