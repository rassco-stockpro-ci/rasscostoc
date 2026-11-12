import type { IInventoryEntriesRepository, InventoryEntryActor, InventoryEntryInput } from "@modules/inventory/application/inventory/contracts/IInventoryEntriesRepository";
import type {
  TechnicianFixedInventoryEntry,
  TechnicianMovingInventoryEntry,
  WarehouseInventoryEntry,
} from "@shared/schema";
import { and, eq } from 'drizzle-orm';
import { getDatabase } from "@core/database/connection";
import { technicianFixedInventoryEntries, technicianMovingInventoryEntries } from "@shared/schema";
import { ConflictError } from "@core/errors/AppError";
import { TechnicianInventoryRepository } from "@modules/inventory/infrastructure/database/TechnicianInventoryRepository";
import { WarehouseInventoryRepository } from "@modules/inventory/infrastructure/database/WarehouseInventoryRepository";
import { assertQuantityWriteAllowed, findIdempotentReplay, logQuantityMovement } from "./quantity-entry-guards";

export class DrizzleInventoryEntriesRepository implements IInventoryEntriesRepository {
  private get db() {
    return getDatabase();
  }

  private readonly warehouseInventory = new WarehouseInventoryRepository();
  private readonly technicianInventory = new TechnicianInventoryRepository();

  async getWarehouseEntries(warehouseId: string): Promise<WarehouseInventoryEntry[]> {
    return this.warehouseInventory.getWarehouseInventoryEntries(warehouseId);
  }

  async upsertWarehouseEntry(warehouseId: string, input: InventoryEntryInput): Promise<WarehouseInventoryEntry> {
    return this.warehouseInventory.upsertWarehouseInventoryEntry(
      warehouseId,
      input.itemTypeId,
      input.boxes,
      input.units,
    );
  }

  async getTechnicianFixedEntries(technicianId: string): Promise<TechnicianFixedInventoryEntry[]> {
    return this.db
      .select()
      .from(technicianFixedInventoryEntries)
      .where(eq(technicianFixedInventoryEntries.technicianId, technicianId));
  }

  async upsertTechnicianFixedEntry(
    technicianId: string,
    input: InventoryEntryInput,
    actor: InventoryEntryActor,
    idempotencyKey: string,
  ): Promise<TechnicianFixedInventoryEntry> {
    return this.db.transaction(async (tx: any) => {
      await assertQuantityWriteAllowed(tx, input.itemTypeId, input.boxes, input.units);

      // Domain-level idempotency replay: if this exact key already applied
      // for this entity type, return the recorded result instead of
      // re-executing the write — proven by a real-SQL test to prevent a
      // retried request from adding the quantity twice.
      const replay = await findIdempotentReplay(tx, "technician_fixed_inventory_entry", idempotencyKey);
      if (replay) {
        const [current] = await tx
          .select()
          .from(technicianFixedInventoryEntries)
          .where(eq(technicianFixedInventoryEntries.id, replay.id));
        if (current) return current;
      }

      const [existing] = await tx
        .select()
        .from(technicianFixedInventoryEntries)
        .where(and(
          eq(technicianFixedInventoryEntries.technicianId, technicianId),
          eq(technicianFixedInventoryEntries.itemTypeId, input.itemTypeId),
        ));

      let result: TechnicianFixedInventoryEntry;
      let before: { boxes: number; units: number } | null = null;

      if (existing) {
        before = { boxes: existing.boxes, units: existing.units };

        // Optimistic lock: if the caller told us the version it last read,
        // the write only applies against that exact version (plain integer
        // equality — exact and reliable, unlike a timestamp CAS, which a
        // real-SQL test proved unreliable: Postgres timestamp has
        // microsecond precision, JS Date only millisecond, so a value read
        // back and sent back for comparison never bit-for-bit matches its
        // own stored value). A mismatch (0 rows affected) means a newer
        // write already landed — reject instead of silently overwriting it
        // (the proven Cycle B defect: absolute overwrite with no
        // concurrency protection at all).
        const whereClause = input.expectedVersion != null
          ? and(
              eq(technicianFixedInventoryEntries.id, existing.id),
              eq(technicianFixedInventoryEntries.version, input.expectedVersion),
            )
          : eq(technicianFixedInventoryEntries.id, existing.id);

        const updatedRows = await tx
          .update(technicianFixedInventoryEntries)
          .set({
            boxes: input.boxes,
            units: input.units,
            updatedAt: new Date(),
            version: existing.version + 1,
          })
          .where(whereClause)
          .returning();

        if (updatedRows.length === 0) {
          throw new ConflictError(
            "تم تعديل هذا الصنف بواسطة عملية أخرى بعد قراءتك الأخيرة — أعد تحميل البيانات وحاول مجدداً (Optimistic lock rejected a stale update)",
          );
        }

        result = updatedRows[0];
      } else {
        const [created] = await tx
          .insert(technicianFixedInventoryEntries)
          .values({
            technicianId,
            itemTypeId: input.itemTypeId,
            boxes: input.boxes,
            units: input.units,
          })
          .returning();

        result = created;
      }

      // Movement/audit record — reused `system_logs` rather than a new
      // parallel table (no schema change needed): this is the ONLY
      // auditable trace of a fixed-inventory quantity change today. Writing
      // it in the same transaction as the balance update means a crash
      // between the two is structurally impossible (the previous code had
      // no movement record for this path at all). Also doubles as the
      // idempotency-replay source checked above.
      await logQuantityMovement(tx, {
        actor,
        action: existing ? "QUANTITY_UPDATE" : "QUANTITY_CREATE",
        entityType: "technician_fixed_inventory_entry",
        entityId: result.id,
        technicianId,
        itemTypeId: input.itemTypeId,
        before,
        after: { boxes: result.boxes, units: result.units },
        idempotencyKey,
        descriptionAr: existing
          ? `تحديث مخزون ثابت: فني ${technicianId}, صنف ${input.itemTypeId}`
          : `إنشاء مخزون ثابت: فني ${technicianId}, صنف ${input.itemTypeId}`,
      });

      return result;
    });
  }

  async getTechnicianMovingEntries(technicianId: string): Promise<TechnicianMovingInventoryEntry[]> {
    return this.technicianInventory.getTechnicianMovingInventoryEntries(technicianId);
  }

  async upsertTechnicianMovingEntry(
    technicianId: string,
    input: InventoryEntryInput,
    actor: InventoryEntryActor,
    idempotencyKey: string,
  ): Promise<TechnicianMovingInventoryEntry> {
    return this.db.transaction(async (tx: any) => {
      await assertQuantityWriteAllowed(tx, input.itemTypeId, input.boxes, input.units);

      const replay = await findIdempotentReplay(tx, "technician_moving_inventory_entry", idempotencyKey);
      if (replay) {
        const [current] = await tx
          .select()
          .from(technicianMovingInventoryEntries)
          .where(eq(technicianMovingInventoryEntries.id, replay.id));
        if (current) return current;
      }

      const [existing] = await tx
        .select()
        .from(technicianMovingInventoryEntries)
        .where(and(
          eq(technicianMovingInventoryEntries.technicianId, technicianId),
          eq(technicianMovingInventoryEntries.itemTypeId, input.itemTypeId),
        ));

      let result: TechnicianMovingInventoryEntry;
      const before = existing ? { boxes: existing.boxes, units: existing.units } : null;

      if (existing) {
        const whereClause = input.expectedVersion != null
          ? and(
              eq(technicianMovingInventoryEntries.id, existing.id),
              eq(technicianMovingInventoryEntries.version, input.expectedVersion),
            )
          : eq(technicianMovingInventoryEntries.id, existing.id);

        const updatedRows = await tx
          .update(technicianMovingInventoryEntries)
          .set({
            boxes: input.boxes,
            units: input.units,
            updatedAt: new Date(),
            version: existing.version + 1,
          })
          .where(whereClause)
          .returning();

        if (updatedRows.length === 0) {
          throw new ConflictError(
            "تم تعديل هذا الصنف بواسطة عملية أخرى بعد قراءتك الأخيرة — أعد تحميل البيانات وحاول مجدداً (Optimistic lock rejected a stale update)",
          );
        }
        result = updatedRows[0];
      } else {
        const [created] = await tx
          .insert(technicianMovingInventoryEntries)
          .values({
            technicianId,
            itemTypeId: input.itemTypeId,
            boxes: input.boxes,
            units: input.units,
          })
          .returning();
        result = created;
      }

      await logQuantityMovement(tx, {
        actor,
        action: existing ? "QUANTITY_UPDATE" : "QUANTITY_CREATE",
        entityType: "technician_moving_inventory_entry",
        entityId: result.id,
        technicianId,
        itemTypeId: input.itemTypeId,
        before,
        after: { boxes: result.boxes, units: result.units },
        idempotencyKey,
        descriptionAr: existing
          ? `تحديث مخزون متحرك: فني ${technicianId}, صنف ${input.itemTypeId}`
          : `إنشاء مخزون متحرك: فني ${technicianId}, صنف ${input.itemTypeId}`,
      });

      return result;
    });
  }
}
