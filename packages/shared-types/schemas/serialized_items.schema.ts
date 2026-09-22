import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, doublePrecision, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users, warehouses } from "./organization.schema";
import { itemTypes } from "./catalog.schema";

// Item Lifecycle States
export const ITEM_STATUSES = [
  "WAREHOUSE", 
  "PENDING_ACCEPTANCE", 
  "IN_TRANSIT_CUSTODY", 
  "RECEIVED_BY_TECHNICIAN",
  "IN_TRANSIT",
  "DELIVERED",
  "RETURNED"
] as const;
export const itemStatusSchema = z.enum(ITEM_STATUSES);

// 1. Items Table - Tracks serialized items like POS Terminals and SIM Cards
export const items = pgTable("items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  itemTypeId: varchar("item_type_id").notNull().references(() => itemTypes.id, { onDelete: "restrict" }),
  serialNumber: text("serial_number").notNull().unique(),
  barcode: text("barcode").notNull().unique(),
  status: text("status").notNull().default("WAREHOUSE"), // WAREHOUSE | PENDING_ACCEPTANCE | IN_TRANSIT_CUSTODY | DELIVERED
  
  // Custody tracking
  currentOwnerId: varchar("current_owner_id").references(() => users.id, { onDelete: "restrict" }),
  warehouseId: varchar("warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
  
  // SIM Card specific fields
  carrierName: text("carrier_name"), // STC | Mobily | Zain | Virgin | Lebara | Salam | Red Bull Mobile
  simPackageType: text("sim_package_type"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  itemsSerialIdx: index("items_serial_idx").on(table.serialNumber),
  itemsBarcodeIdx: index("items_barcode_idx").on(table.barcode),
  itemsStatusIdx: index("items_status_idx").on(table.status),
  itemsOwnerIdx: index("items_owner_idx").on(table.currentOwnerId),
}));

// 2. Inventory Transactions Table - Logs logistical/field transactions
export const inventoryTransactions = pgTable("inventory_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  itemId: varchar("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  transactionType: text("transaction_type").notNull(), // INTAKE | CHECKOUT | TRANSFER | DELIVERY
  
  sourceOwnerId: varchar("source_owner_id").references(() => users.id),
  destinationOwnerId: varchar("destination_owner_id").references(() => users.id),
  sourceWarehouseId: varchar("source_warehouse_id").references(() => warehouses.id),
  destinationWarehouseId: varchar("destination_warehouse_id").references(() => warehouses.id),
  
  // Delivery details (Feature 2)
  receiverName: text("receiver_name"),
  orderNumber: text("order_number"),
  
  // Handover coordinates for GPS validation
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  transItemIdIdx: index("inv_trans_item_id_idx").on(table.itemId),
  transOrderNoIdx: index("inv_trans_order_no_idx").on(table.orderNumber),
}));

// 3. Item History Logs Table - Tracks all lifecycle state transitions
export const itemHistoryLogs = pgTable("item_history_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  itemId: varchar("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  changedById: varchar("changed_by_id").notNull().references(() => users.id),
  changedAt: timestamp("changed_at").defaultNow(),
  notes: text("notes"),
}, (table) => ({
  historyItemIdIdx: index("history_item_id_idx").on(table.itemId),
}));

// 4. Custody Movements Table - Tracks item ownership changes over time (Ledger)
export const custodyMovements = pgTable("custody_movements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  itemId: varchar("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  fromOwnerId: varchar("from_owner_id").references(() => users.id, { onDelete: "restrict" }),
  toOwnerId: varchar("to_owner_id").references(() => users.id, { onDelete: "restrict" }),
  fromWarehouseId: varchar("from_warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
  toWarehouseId: varchar("to_warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(), // INTAKE, TRANSFER, DELIVERY, RETURN, REPLACEMENT
  referenceType: text("reference_type"), // WAREHOUSE_TRANSFER, COURIER_REQUEST, etc.
  referenceId: varchar("reference_id"),
  performedById: varchar("performed_by_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  performedAt: timestamp("performed_at").defaultNow().notNull(),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  notes: text("notes"),
}, (table) => ({
  custodyItemIdIdx: index("custody_movements_item_id_idx").on(table.itemId),
  custodyFromOwnerIdx: index("custody_movements_from_owner_idx").on(table.fromOwnerId),
  custodyToOwnerIdx: index("custody_movements_to_owner_idx").on(table.toOwnerId),
}));

// Insert Schemas for Zod Validations
export const insertItemSchema = createInsertSchema(items).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertInventoryTransactionSchema = createInsertSchema(inventoryTransactions).omit({
  id: true,
  createdAt: true,
});

export const insertItemHistoryLogSchema = createInsertSchema(itemHistoryLogs).omit({
  id: true,
  changedAt: true,
});

export const insertCustodyMovementSchema = createInsertSchema(custodyMovements).omit({
  id: true,
  performedAt: true,
});

// TypeScript Types
export type Item = typeof items.$inferSelect;
export type InsertItem = z.infer<typeof insertItemSchema>;
export type InventoryTransaction = typeof inventoryTransactions.$inferSelect;
export type InsertInventoryTransaction = z.infer<typeof insertInventoryTransactionSchema>;
export type ItemHistoryLog = typeof itemHistoryLogs.$inferSelect;
export type InsertItemHistoryLog = z.infer<typeof insertItemHistoryLogSchema>;
export type CustodyMovement = typeof custodyMovements.$inferSelect;
export type InsertCustodyMovement = z.infer<typeof insertCustodyMovementSchema>;

