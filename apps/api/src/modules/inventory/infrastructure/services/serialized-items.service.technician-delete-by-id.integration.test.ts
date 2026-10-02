import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@core/config/db";
import { serializedItemsService } from "./serialized-items.service";

/**
 * TEMPORARY FEATURE — remove after final inventory workflow is released.
 *
 * Real-database integration test (no mocks) for technicianDeleteOwnSerializedItem.
 * All fixtures are created with obviously-fake, test-only identifiers and are fully
 * removed in afterAll. This test never reads, modifies, or deletes any pre-existing
 * row — it only touches rows it creates itself in beforeAll. Mirrors the existing
 * deleteFromTechnicianCustody integration test's fixture-and-cleanup pattern.
 */
describe("SerializedItemsService.technicianDeleteOwnSerializedItem — real database integration", () => {
  let runId: string;
  let techAId: string;
  let techBId: string;
  let itemTypeId: string;
  let itemActiveAId: string;
  let itemActiveBId: string;
  let itemDeliveredAId: string;
  let itemDeliveredBId: string;

  beforeAll(async () => {
    runId = Date.now().toString() + "_" + Math.floor(Math.random() * 10000).toString();
    itemTypeId = `test_tech_del_type_${runId}`;

    await pool.query(
      `INSERT INTO item_types (id, name_ar, name_en, category, sort_order)
       VALUES ($1, $2, $3, 'devices', 999)`,
      [itemTypeId, "نوع اختبار حذف الفني", "Technician Delete-By-Id Test Item Type"]
    );

    const techA = await pool.query(
      `INSERT INTO users (username, email, password, full_name, role)
       VALUES ($1, $2, $3, $4, 'technician') RETURNING id`,
      [`tech_del_id_a_${runId}`, `tech-del-id-a-${runId}@example.invalid`, "test-fixture-hash", "Technician Delete-By-Id Test A"]
    );
    techAId = techA.rows[0].id;

    const techB = await pool.query(
      `INSERT INTO users (username, email, password, full_name, role)
       VALUES ($1, $2, $3, $4, 'technician') RETURNING id`,
      [`tech_del_id_b_${runId}`, `tech-del-id-b-${runId}@example.invalid`, "test-fixture-hash", "Technician Delete-By-Id Test B"]
    );
    techBId = techB.rows[0].id;

    // Active item actively held by technician A.
    const itemActiveA = await pool.query(
      `INSERT INTO items (item_type_id, serial_number, barcode, status, current_owner_id)
       VALUES ($1, $2, $2, 'RECEIVED_BY_TECHNICIAN', $3) RETURNING id`,
      [itemTypeId, `TESTTECHDELACTA_${runId}`, techAId]
    );
    itemActiveAId = itemActiveA.rows[0].id;

    // Active item actively held by technician B (used to prove A can't delete it).
    const itemActiveB = await pool.query(
      `INSERT INTO items (item_type_id, serial_number, barcode, status, current_owner_id)
       VALUES ($1, $2, $2, 'RECEIVED_BY_TECHNICIAN', $3) RETURNING id`,
      [itemTypeId, `TESTTECHDELACTB_${runId}`, techBId]
    );
    itemActiveBId = itemActiveB.rows[0].id;

    // Item delivered by technician A in the past (currentOwnerId now NULL, as scanOut leaves it).
    const itemDeliveredA = await pool.query(
      `INSERT INTO items (item_type_id, serial_number, barcode, status, current_owner_id)
       VALUES ($1, $2, $2, 'DELIVERED', NULL) RETURNING id`,
      [itemTypeId, `TESTTECHDELDLVA_${runId}`]
    );
    itemDeliveredAId = itemDeliveredA.rows[0].id;
    await pool.query(
      `INSERT INTO custody_movements (item_id, from_owner_id, to_owner_id, reason, performed_by_id)
       VALUES ($1, $2, NULL, 'DELIVERED', $2)`,
      [itemDeliveredAId, techAId]
    );

    // Item delivered by technician B in the past — used to prove A can't delete it
    // even though currentOwnerId is NULL on both (the ledger is what distinguishes them).
    const itemDeliveredB = await pool.query(
      `INSERT INTO items (item_type_id, serial_number, barcode, status, current_owner_id)
       VALUES ($1, $2, $2, 'DELIVERED', NULL) RETURNING id`,
      [itemTypeId, `TESTTECHDELDLVB_${runId}`]
    );
    itemDeliveredBId = itemDeliveredB.rows[0].id;
    await pool.query(
      `INSERT INTO custody_movements (item_id, from_owner_id, to_owner_id, reason, performed_by_id)
       VALUES ($1, $2, NULL, 'DELIVERED', $2)`,
      [itemDeliveredBId, techBId]
    );

    // Seed technician A's moving-inventory balance at 2 (one for itemActiveA, one
    // notional other unit) so the real decrement (2 -> 1) can be proven, and then
    // proven to stay at 1 (not drop further) after the DELIVERED-item delete.
    await pool.query(
      `INSERT INTO technician_moving_inventory_entries (technician_id, item_type_id, units, boxes)
       VALUES ($1, $2, 2, 0)`,
      [techAId, itemTypeId]
    );
  });

  afterAll(async () => {
    const allItemIds = [itemActiveAId, itemActiveBId, itemDeliveredAId, itemDeliveredBId].filter(Boolean);
    if (allItemIds.length) {
      await pool.query(`DELETE FROM system_logs WHERE entity_id = ANY($1)`, [allItemIds]);
      await pool.query(`DELETE FROM custody_movements WHERE item_id = ANY($1)`, [allItemIds]);
      await pool.query(`DELETE FROM item_history_logs WHERE item_id = ANY($1)`, [allItemIds]);
      await pool.query(`DELETE FROM inventory_transactions WHERE item_id = ANY($1)`, [allItemIds]);
      await pool.query(`DELETE FROM items WHERE id = ANY($1)`, [allItemIds]);
    }
    await pool.query(`DELETE FROM technician_moving_inventory_entries WHERE technician_id IN ($1, $2)`, [techAId, techBId]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [techAId, techBId]);
    if (itemTypeId) {
      await pool.query(`DELETE FROM item_types WHERE id = $1`, [itemTypeId]);
    }
  });

  it("blocks technician A from deleting technician B's real actively-held item — 403, item still exists, A's balance untouched", async () => {
    await expect(
      serializedItemsService.technicianDeleteOwnSerializedItem(
        techAId,
        `tech_del_id_a_${runId}`,
        "technician",
        itemActiveBId
      )
    ).rejects.toMatchObject({ statusCode: 403, code: "ITEM_NOT_IN_YOUR_CUSTODY" });

    const stillThere = await pool.query(`SELECT id FROM items WHERE id = $1`, [itemActiveBId]);
    expect(stillThere.rows.length).toBe(1);

    const balance = await pool.query(
      `SELECT units FROM technician_moving_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`,
      [techAId, itemTypeId]
    );
    expect(balance.rows[0].units).toBe(2);
  });

  it("blocks technician A from deleting technician B's real DELIVERED item — 403, item still exists (currentOwnerId being NULL on both is not enough)", async () => {
    await expect(
      serializedItemsService.technicianDeleteOwnSerializedItem(
        techAId,
        `tech_del_id_a_${runId}`,
        "technician",
        itemDeliveredBId
      )
    ).rejects.toMatchObject({ statusCode: 403, code: "ITEM_NOT_IN_YOUR_CUSTODY" });

    const stillThere = await pool.query(`SELECT id FROM items WHERE id = $1`, [itemDeliveredBId]);
    expect(stillThere.rows.length).toBe(1);
  });

  it("genuinely deletes technician A's own actively-held item and decrements the real balance (2 -> 1)", async () => {
    const result = await serializedItemsService.technicianDeleteOwnSerializedItem(
      techAId,
      `tech_del_id_a_${runId}`,
      "technician",
      itemActiveAId
    );
    expect(result).toMatchObject({ itemId: itemActiveAId, deleted: true });

    const itemRow = await pool.query(`SELECT id FROM items WHERE id = $1`, [itemActiveAId]);
    expect(itemRow.rows.length).toBe(0);

    const balance = await pool.query(
      `SELECT units FROM technician_moving_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`,
      [techAId, itemTypeId]
    );
    expect(balance.rows[0].units).toBe(1);

    const auditRow = await pool.query(
      `SELECT details FROM system_logs WHERE entity_id = $1 AND action = 'technician_delete_own_serialized_item'`,
      [itemActiveAId]
    );
    expect(auditRow.rows.length).toBe(1);
  });

  it("genuinely deletes technician A's own DELIVERED item (real custody_movements match) — balance stays at 1, NOT decremented again", async () => {
    const result = await serializedItemsService.technicianDeleteOwnSerializedItem(
      techAId,
      `tech_del_id_a_${runId}`,
      "technician",
      itemDeliveredAId
    );
    expect(result).toMatchObject({ itemId: itemDeliveredAId, deleted: true });

    const itemRow = await pool.query(`SELECT id FROM items WHERE id = $1`, [itemDeliveredAId]);
    expect(itemRow.rows.length).toBe(0);

    // This is the exact double-decrement bug this whole feature must never
    // reintroduce: scanOut already decremented once at delivery time, so
    // deleting the DELIVERED row here must leave the balance at 1 — not 0.
    const balance = await pool.query(
      `SELECT units FROM technician_moving_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`,
      [techAId, itemTypeId]
    );
    expect(balance.rows[0].units).toBe(1);
  });

  it("returns 404 for an item id that was never registered, and never touches the balance", async () => {
    await expect(
      serializedItemsService.technicianDeleteOwnSerializedItem(
        techAId,
        `tech_del_id_a_${runId}`,
        "technician",
        "00000000-0000-0000-0000-000000000000"
      )
    ).rejects.toMatchObject({ statusCode: 404 });

    const balance = await pool.query(
      `SELECT units FROM technician_moving_inventory_entries WHERE technician_id = $1 AND item_type_id = $2`,
      [techAId, itemTypeId]
    );
    expect(balance.rows[0].units).toBe(1);
  });
});
