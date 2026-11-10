import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { itemTypes, regions } from "./catalog.schema";
import { users } from "./organization.schema";

export const inventoryItems = pgTable("inventory_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: text("type").notNull(),
  unit: text("unit").notNull(),
  quantity: integer("quantity").notNull().default(0),
  minThreshold: integer("min_threshold").notNull().default(5),
  technicianName: text("technician_name"),
  city: text("city"),
  regionId: varchar("region_id").references(() => regions.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  inventoryItemsRegionIdx: index("inventory_items_region_idx").on(table.regionId),
  inventoryItemsTypeIdx: index("inventory_items_type_idx").on(table.type),
}));

export const techniciansInventory = pgTable("technicians_inventory", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  technicianName: text("technician_name").notNull(),
  city: text("city").notNull(),
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
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id),
  regionId: varchar("region_id").references(() => regions.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  techInvCreatedByIdx: index("tech_inv_created_by_idx").on(table.createdBy),
  techInvRegionIdx: index("tech_inv_region_idx").on(table.regionId),
}));

export const transactions = pgTable("transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  itemId: varchar("item_id").notNull().references(() => inventoryItems.id),
  userId: varchar("user_id").references(() => users.id),
  type: text("type").notNull(),
  quantity: integer("quantity").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  transactionItemIdIdx: index("transactions_item_id_idx").on(table.itemId),
  transactionUserIdIdx: index("transactions_user_id_idx").on(table.userId),
}));

export const withdrawnDevices = pgTable("withdrawn_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  city: text("city").notNull(),
  technicianName: text("technician_name").notNull(),
  terminalId: text("terminal_id").notNull(),
  serialNumber: text("serial_number").notNull(),
  battery: text("battery").notNull(),
  chargerCable: text("charger_cable").notNull(),
  chargerHead: text("charger_head").notNull(),
  hasSim: text("has_sim").notNull(),
  simCardType: text("sim_card_type"),
  damagePart: text("damage_part"),
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id),
  regionId: varchar("region_id").references(() => regions.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  withdrawnCreatedByIdx: index("withdrawn_devices_created_by_idx").on(table.createdBy),
  withdrawnRegionIdx: index("withdrawn_devices_region_idx").on(table.regionId),
  withdrawnSerialIdx: index("withdrawn_devices_serial_idx").on(table.serialNumber),
}));

export const receivedDevices = pgTable("received_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  technicianId: varchar("technician_id").notNull().references(() => users.id),
  supervisorId: varchar("supervisor_id").references(() => users.id),
  itemTypeId: varchar("item_type_id").references(() => itemTypes.id),
  terminalId: text("terminal_id"),
  serialNumber: text("serial_number").notNull(),
  battery: boolean("battery").notNull().default(false),
  chargerCable: boolean("charger_cable").notNull().default(false),
  chargerHead: boolean("charger_head").notNull().default(false),
  hasSim: boolean("has_sim").notNull().default(false),
  simCardType: text("sim_card_type"),
  damagePart: text("damage_part").default(""),
  status: text("status").notNull().default("pending"),
  inventoryType: text("inventory_type").notNull().default("fixed"),
  adminNotes: text("admin_notes"),
  approvedBy: varchar("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  regionId: varchar("region_id").references(() => regions.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  receivedTechIdx: index("received_devices_tech_idx").on(table.technicianId),
  receivedSupervisorIdx: index("received_devices_supervisor_idx").on(table.supervisorId),
  receivedApprovedByIdx: index("received_devices_approved_by_idx").on(table.approvedBy),
  receivedItemIdx: index("received_devices_item_type_idx").on(table.itemTypeId),
  receivedRegionIdx: index("received_devices_region_idx").on(table.regionId),
  receivedSerialIdx: index("received_devices_serial_idx").on(table.serialNumber),
}));

export const technicianFixedInventories = pgTable("technician_fixed_inventories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  technicianId: varchar("technician_id").notNull().references(() => users.id),
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
  lowStockThreshold: integer("low_stock_threshold").notNull().default(30),
  criticalStockThreshold: integer("critical_stock_threshold").notNull().default(70),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  techFixedInvTechIdx: index("tech_fixed_inv_tech_idx").on(table.technicianId),
}));

export const stockMovements = pgTable("stock_movements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  technicianId: varchar("technician_id").notNull().references(() => users.id),
  itemType: text("item_type").notNull(),
  packagingType: text("packaging_type").notNull(),
  quantity: integer("quantity").notNull(),
  fromInventory: text("from_inventory").notNull(),
  toInventory: text("to_inventory").notNull(),
  reason: text("reason"),
  performedBy: varchar("performed_by").notNull().references(() => users.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  stockMovTechIdx: index("stock_movements_tech_idx").on(table.technicianId),
  stockMovPerfIdx: index("stock_movements_perf_idx").on(table.performedBy),
}));

export const technicianFixedInventoryEntries = pgTable("technician_fixed_inventory_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  technicianId: varchar("technician_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  itemTypeId: varchar("item_type_id").notNull().references(() => itemTypes.id, { onDelete: "cascade" }),
  boxes: integer("boxes").notNull().default(0),
  units: integer("units").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
  /**
   * Optimistic-lock token. An exact-equality timestamp CAS was tried first
   * and proven unreliable by a real-SQL test: Postgres `timestamp` has
   * microsecond precision, JS `Date` only millisecond — a value read back
   * and sent back for comparison never bit-for-bit matches its own stored
   * value, so a timestamp-based lock would reject legitimate unmodified
   * writes, not just genuinely stale ones. A plain incrementing integer
   * has no such precision pitfall. Schema change only — no migration has
   * been run against any real database; that requires separate approval.
   */
  version: integer("version").notNull().default(0),
}, (table) => ({
  fixedEntriesTechIdx: index("fixed_entries_tech_idx").on(table.technicianId),
  fixedEntriesItemIdx: index("fixed_entries_item_idx").on(table.itemTypeId),
}));

export const technicianMovingInventoryEntries = pgTable("technician_moving_inventory_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  technicianId: varchar("technician_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  itemTypeId: varchar("item_type_id").notNull().references(() => itemTypes.id, { onDelete: "cascade" }),
  boxes: integer("boxes").notNull().default(0),
  units: integer("units").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  movingEntriesTechIdx: index("moving_entries_tech_idx").on(table.technicianId),
  movingEntriesItemIdx: index("moving_entries_item_idx").on(table.itemTypeId),
}));

export const insertInventoryItemSchema = createInsertSchema(inventoryItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTechnicianInventorySchema = createInsertSchema(techniciansInventory).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTransactionSchema = createInsertSchema(transactions).omit({
  id: true,
  createdAt: true,
});

export const insertWithdrawnDeviceSchema = createInsertSchema(withdrawnDevices).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertReceivedDeviceSchema = createInsertSchema(receivedDevices, {
  technicianId: z.string(),
  supervisorId: z.string().nullable().optional(),
  itemTypeId: z.string().nullable().optional(),
  regionId: z.string().nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  approvedBy: true,
  approvedAt: true,
  adminNotes: true,
  status: true,
});

export const insertTechnicianFixedInventorySchema = createInsertSchema(technicianFixedInventories).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertStockMovementSchema = createInsertSchema(stockMovements).omit({
  id: true,
  createdAt: true,
});

export const insertTechnicianFixedInventoryEntrySchema = createInsertSchema(technicianFixedInventoryEntries).omit({
  id: true,
  updatedAt: true,
});

export const insertTechnicianMovingInventoryEntrySchema = createInsertSchema(technicianMovingInventoryEntries).omit({
  id: true,
  updatedAt: true,
});

export type InsertInventoryItem = z.infer<typeof insertInventoryItemSchema>;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InsertTechnicianInventory = z.infer<typeof insertTechnicianInventorySchema>;
export type TechnicianInventory = typeof techniciansInventory.$inferSelect;
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactions.$inferSelect;
export type InsertWithdrawnDevice = z.infer<typeof insertWithdrawnDeviceSchema>;
export type WithdrawnDevice = typeof withdrawnDevices.$inferSelect;
export type InsertReceivedDevice = z.infer<typeof insertReceivedDeviceSchema>;
export type ReceivedDevice = typeof receivedDevices.$inferSelect;
export type InsertTechnicianFixedInventory = z.infer<typeof insertTechnicianFixedInventorySchema>;
export type TechnicianFixedInventory = typeof technicianFixedInventories.$inferSelect;
export type InsertStockMovement = z.infer<typeof insertStockMovementSchema>;
export type StockMovement = typeof stockMovements.$inferSelect;
export type InsertTechnicianFixedInventoryEntry = z.infer<typeof insertTechnicianFixedInventoryEntrySchema>;
export type TechnicianFixedInventoryEntry = typeof technicianFixedInventoryEntries.$inferSelect;
export type InsertTechnicianMovingInventoryEntry = z.infer<typeof insertTechnicianMovingInventoryEntrySchema>;
export type TechnicianMovingInventoryEntry = typeof technicianMovingInventoryEntries.$inferSelect;
