import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, unique, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { itemTypes, regions } from "./catalog.schema";

// Users table for all user accounts
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  fullName: text("full_name").notNull(),
  profileImage: text("profile_image"),
  city: text("city"),
  role: text("role").notNull().default("technician"),
  regionId: varchar("region_id").references(() => regions.id),
  employeeCode: text("employee_code"),
  technicianCode: text("technician_code"),
  department: text("department"),
  permissions: text("permissions"), // JSON string representation of custom permissions
  isActive: boolean("is_active").notNull().default(true),
  // Monotonically incremented on every deactivation only; never decremented or
  // reset on reactivation. Binds every issued credential (JWT, refresh token,
  // Express session) to the account state at the moment it was authenticated,
  // so a deactivation permanently invalidates every credential issued before it,
  // even ones created mid-flight or reused after a later reactivation.
  authGeneration: integer("auth_generation").notNull().default(0),
  fcmToken: text("fcm_token"),
  // ربط حساب الفني برقم مستخدمه في تيليجرام (بوت توثيق التركيب) - يُستخدم لتحديد هوية
  // الفني الفعلي عند رفع تقارير courier/pdf عبر البوت بدل حساب خدمة عام واحد.
  telegramUserId: text("telegram_user_id").unique(),
  // Recorded by the bot's self-link flow (POST /api/telegram/link): the Telegram @username seen at link time and when it was linked.
  // NULL for accounts an admin linked before 0064 (their link date is unknown and is not invented).
  telegramUsername: text("telegram_username"),
  telegramLinkedAt: timestamp("telegram_linked_at"),
  // Last time the bot successfully acted for this user (throttled to one write per minute).
  telegramLastSeenAt: timestamp("telegram_last_seen_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Warehouses - المستودعات الرئيسية لتخزين المخزون
export const warehouses = pgTable("warehouses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  location: text("location").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  regionId: varchar("region_id").references(() => regions.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/** Stored file attachment (image/PDF as data URL) for employee profile docs */
export const employeeStoredFileSchema = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number(),
  dataUrl: z.string(),
  uploadedAt: z.string(),
});

export type EmployeeStoredFile = z.infer<typeof employeeStoredFileSchema>;

/** Extended HR / custody / documents for an employee — synced portal ↔ mobile */
export const employeeProfileDataSchema = z.object({
  nationalId: z.string().optional(),
  phoneNumber: z.string().optional(),
  birthDate: z.string().optional(),
  nationalIdExpiryDate: z.string().optional(),
  sponsorName: z.string().optional(),
  licenseExpiryDate: z.string().optional(),
  passportNumber: z.string().optional(),
  passportExpiryDate: z.string().optional(),
  nationality: z.string().optional(),
  absherNumber: z.string().optional(),
  qualification: z.string().optional(),
  jobTitle: z.string().optional(),
  employeeNumber: z.string().optional(),
  projectName: z.string().optional(),
  city: z.string().optional(),
  carPlateNumber: z.string().optional(),
  carType: z.string().optional(),
  carModel: z.string().optional(),
  carYear: z.string().optional(),
  phoneType: z.string().optional(),
  phoneSerial: z.string().optional(),
  businessPhoneNumber: z.string().optional(),
  simType: z.string().optional(),
  jobOfferFile: employeeStoredFileSchema.nullish(),
  promissoryNoteFile: employeeStoredFileSchema.nullish(),
  carHandoverFile: employeeStoredFileSchema.nullish(),
  otherFiles: z.array(employeeStoredFileSchema).max(5).optional(),
});

export type EmployeeProfileData = z.infer<typeof employeeProfileDataSchema>;

export const employeeProfiles = pgTable("employee_profiles", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  profileData: jsonb("profile_data").$type<EmployeeProfileData>().notNull().default({}),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const upsertEmployeeProfileSchema = employeeProfileDataSchema.extend({
  fullName: z.string().min(1).optional(),
  city: z.string().optional(),
  profileImage: z.string().optional(),
});

export type UpsertEmployeeProfileInput = z.infer<typeof upsertEmployeeProfileSchema>;

// Supervisor-Technician Assignments - ربط المشرف بالمندوبين
export const supervisorTechnicians = pgTable("supervisor_technicians", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  supervisorId: varchar("supervisor_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  technicianId: varchar("technician_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  uniqSupervisorTechnician: sql`UNIQUE (${table.supervisorId}, ${table.technicianId})`,
}));

// Supervisor-Warehouse Assignments - ربط المشرف بالمستودعات
export const supervisorWarehouses = pgTable("supervisor_warehouses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  supervisorId: varchar("supervisor_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  warehouseId: varchar("warehouse_id").notNull().references(() => warehouses.id, { onDelete: 'cascade' }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  uniqSupervisorWarehouse: sql`UNIQUE (${table.supervisorId}, ${table.warehouseId})`,
}));

// Warehouse Inventory - مخزون المستودع (يتتبع الكراتين والوحدات منفصلة)
export const warehouseInventory = pgTable("warehouse_inventory", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  warehouseId: varchar("warehouse_id").notNull().references(() => warehouses.id, { onDelete: 'cascade' }),
  n950Boxes: integer("n950_boxes").notNull().default(0),
  n950Units: integer("n950_units").notNull().default(0),
  i9000sBoxes: integer("i9000s_boxes").notNull().default(0),
  i9000sUnits: integer("i9000s_units").notNull().default(0),
  i9100Boxes: integer("i9100_boxes").notNull().default(0),
  i9100Units: integer("i9100_units").notNull().default(0),
  rollPaperBoxes: integer("roll_paper_boxes").notNull().default(0),
  rollPaperUnits: integer("roll_paper_units").notNull().default(0),
  stickersBoxes: integer("stickers_boxes").notNull().default(0),
  stickersUnits: integer("stickers_units").notNull().default(0),
  newBatteriesBoxes: integer("new_batteries_boxes").notNull().default(0),
  newBatteriesUnits: integer("new_batteries_units").notNull().default(0),
  mobilySimBoxes: integer("mobily_sim_boxes").notNull().default(0),
  mobilySimUnits: integer("mobily_sim_units").notNull().default(0),
  stcSimBoxes: integer("stc_sim_boxes").notNull().default(0),
  stcSimUnits: integer("stc_sim_units").notNull().default(0),
  zainSimBoxes: integer("zain_sim_boxes").notNull().default(0),
  zainSimUnits: integer("zain_sim_units").notNull().default(0),
  lebaraBoxes: integer("lebara_boxes").notNull().default(0),
  lebaraUnits: integer("lebara_units").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Dynamic Warehouse Inventory Entries - مخزون المستودع الديناميكي
export const warehouseInventoryEntries = pgTable("warehouse_inventory_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  warehouseId: varchar("warehouse_id").notNull().references(() => warehouses.id, { onDelete: 'cascade' }),
  itemTypeId: varchar("item_type_id").notNull().references(() => itemTypes.id, { onDelete: 'cascade' }),
  boxes: integer("boxes").notNull().default(0),
  units: integer("units").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => ({
  warehouseItemUnique: unique("warehouse_inventory_entries_warehouse_item_unique").on(t.warehouseId, t.itemTypeId),
}));

// Inventory Requests - طلبات المخزون من المندوبين
export const inventoryRequests = pgTable("inventory_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  technicianId: varchar("technician_id").notNull().references(() => users.id),
  warehouseId: varchar("warehouse_id").references(() => warehouses.id),
  n950Boxes: integer("n950_boxes").default(0),
  n950Units: integer("n950_units").default(0),
  i9000sBoxes: integer("i9000s_boxes").default(0),
  i9000sUnits: integer("i9000s_units").default(0),
  i9100Boxes: integer("i9100_boxes").default(0),
  i9100Units: integer("i9100_units").default(0),
  rollPaperBoxes: integer("roll_paper_boxes").default(0),
  rollPaperUnits: integer("roll_paper_units").default(0),
  stickersBoxes: integer("stickers_boxes").default(0),
  stickersUnits: integer("stickers_units").default(0),
  newBatteriesBoxes: integer("new_batteries_boxes").default(0),
  newBatteriesUnits: integer("new_batteries_units").default(0),
  mobilySimBoxes: integer("mobily_sim_boxes").default(0),
  mobilySimUnits: integer("mobily_sim_units").default(0),
  stcSimBoxes: integer("stc_sim_boxes").default(0),
  stcSimUnits: integer("stc_sim_units").default(0),
  zainSimBoxes: integer("zain_sim_boxes").default(0),
  zainSimUnits: integer("zain_sim_units").default(0),
  lebaraBoxes: integer("lebara_boxes").default(0),
  lebaraUnits: integer("lebara_units").default(0),
  notes: text("notes"),
  status: text("status").notNull().default("pending"),
  adminNotes: text("admin_notes"),
  respondedBy: varchar("responded_by").references(() => users.id),
  respondedAt: timestamp("responded_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Warehouse Transfers - سجل نقل البضائع من المستودع إلى المندوب
export const warehouseTransfers = pgTable("warehouse_transfers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  requestId: varchar("request_id").references(() => inventoryRequests.id),
  warehouseId: varchar("warehouse_id").notNull().references(() => warehouses.id),
  technicianId: varchar("technician_id").notNull().references(() => users.id),
  itemType: text("item_type").notNull(),
  packagingType: text("packaging_type").notNull(),
  quantity: integer("quantity").notNull(),
  performedBy: varchar("performed_by").notNull().references(() => users.id),
  notes: text("notes"),
  status: text("status").notNull().default("pending"),
  transferType: text("transfer_type").notNull().default("WAREHOUSE_TRANSFER"),
  rejectionReason: text("rejection_reason"),
  respondedAt: timestamp("responded_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// OPS-PERM-S0-B1-C.I2A: authGeneration is server-managed credential-revocation
// state — no legitimate client create/update request ever supplies it. Omitting
// it here (rather than relying on call-site discipline) means it is absent
// from InsertUser at the type level, and any unrecognized "authGeneration" key
// in an incoming request body is silently stripped by this schema before the
// request ever reaches application code.
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  authGeneration: true,
}).extend({
  role: z.enum(["admin", "supervisor", "technician", "viewer", "courier_supervisor", "warehouse"]),
});

export const insertSupervisorTechnicianSchema = createInsertSchema(supervisorTechnicians).omit({
  id: true,
  createdAt: true,
});

export const insertSupervisorWarehouseSchema = createInsertSchema(supervisorWarehouses).omit({
  id: true,
  createdAt: true,
});

export const insertWarehouseSchema = createInsertSchema(warehouses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
});

export const insertWarehouseInventorySchema = createInsertSchema(warehouseInventory).omit({
  id: true,
  updatedAt: true,
  warehouseId: true,
});

export const insertWarehouseInventoryEntrySchema = createInsertSchema(warehouseInventoryEntries).omit({
  id: true,
  updatedAt: true,
});

export const insertWarehouseTransferSchema = createInsertSchema(warehouseTransfers).omit({
  id: true,
  createdAt: true,
});

export const insertInventoryRequestSchema = createInsertSchema(inventoryRequests).omit({
  id: true,
  createdAt: true,
  respondedBy: true,
  respondedAt: true,
});

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type UserSafe = Omit<User, "password">;
export type EmployeeProfile = typeof employeeProfiles.$inferSelect;
export type SupervisorTechnician = typeof supervisorTechnicians.$inferSelect;
export type InsertSupervisorTechnician = z.infer<typeof insertSupervisorTechnicianSchema>;
export type SupervisorWarehouse = typeof supervisorWarehouses.$inferSelect;
export type InsertSupervisorWarehouse = z.infer<typeof insertSupervisorWarehouseSchema>;
export type Warehouse = typeof warehouses.$inferSelect;
export type InsertWarehouse = z.infer<typeof insertWarehouseSchema>;
export type WarehouseInventory = typeof warehouseInventory.$inferSelect;
export type InsertWarehouseInventory = z.infer<typeof insertWarehouseInventorySchema>;
export type WarehouseInventoryEntry = typeof warehouseInventoryEntries.$inferSelect;
export type InsertWarehouseInventoryEntry = z.infer<typeof insertWarehouseInventoryEntrySchema>;
export type WarehouseTransfer = typeof warehouseTransfers.$inferSelect;
export type InsertWarehouseTransfer = z.infer<typeof insertWarehouseTransferSchema>;
export type InventoryRequest = typeof inventoryRequests.$inferSelect;
export type InsertInventoryRequest = z.infer<typeof insertInventoryRequestSchema>;

