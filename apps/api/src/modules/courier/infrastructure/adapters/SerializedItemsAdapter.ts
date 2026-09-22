/**
 * SerializedItemsAdapter
 *
 * Implements ISerializedInventoryRepository by wrapping serializedItemsService.
 * This is the only file that knows about serializedItemsService in the Inventory layer.
 * Serials are resolved via Central Serial Engine before custody checks.
 *
 * OPS-REMED-E3: this file (infrastructure/) is the permitted boundary for
 * casting the opaque InventoryTransactionContext to the real Drizzle
 * transaction — never done in the application layer.
 */

import { db } from "@server/core/config/db";
import { items } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { ISerializedInventoryRepository } from "../../application/inventory/ISerializedInventoryRepository";
import type { InventoryTransactionContext } from "../../application/inventory/inventory.engine.types";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";
import { unwrapInventoryTransactionContext } from "../database/DrizzleInventoryTransactionRunner";

export class SerializedItemsAdapter implements ISerializedInventoryRepository {
  /**
   * OPS-REMED-E3: resolve a raw serial to the exact physical item it refers
   * to, without writing anything. Matches items by ANY candidate
   * representation against serialNumber OR barcode. If more than one
   * DISTINCT item.id is found across the candidate set, this is a genuine
   * identity ambiguity — never picked via an arbitrary LIMIT 1; the caller
   * must treat this as DEDUCT_SERIAL_CONFLICT.
   */
  async resolveItemId(rawSerial: string, ctx?: InventoryTransactionContext): Promise<string | null> {
    const client = ctx ? unwrapInventoryTransactionContext(ctx) : db;
    const candidates = await SerialRecognitionService.buildStoredSerialCandidates(
      rawSerial,
      undefined,
      client
    );
    if (candidates.length === 0) return null;

    const matches = await client
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          inArray(items.serialNumber, candidates)
        )
      );

    const byBarcode = await client
      .select({ id: items.id })
      .from(items)
      .where(inArray(items.barcode, candidates));

    const distinctIds = new Set<string>([
      ...matches.map((m: any) => m.id),
      ...byBarcode.map((m: any) => m.id),
    ]);

    if (distinctIds.size === 0) return null;
    if (distinctIds.size > 1) {
      throw new Error(
        `[SerializedItemsAdapter] Serial "${rawSerial}" resolves ambiguously to ${distinctIds.size} distinct items — refusing to pick one arbitrarily.`
      );
    }
    return [...distinctIds][0];
  }

  async scanOut(
    technicianId: string,
    serialNumber: string,
    customerName: string,
    referenceNumber: string,
    ctx?: InventoryTransactionContext
  ): Promise<boolean> {
    const client = ctx ? unwrapInventoryTransactionContext(ctx) : db;
    const candidates = await SerialRecognitionService.buildStoredSerialCandidates(
      serialNumber,
      undefined,
      client
    );

    const [item] = await client
      .select({ id: items.id, serialNumber: items.serialNumber })
      .from(items)
      .where(
        and(
          inArray(items.serialNumber, candidates),
          eq(items.currentOwnerId, technicianId),
          inArray(items.status, ["IN_TRANSIT_CUSTODY", "RECEIVED_BY_TECHNICIAN"])
        )
      )
      .limit(1);

    if (!item) return false;

    const { serializedItemsService } = await import(
      "../../../inventory/contracts"
    );

    await serializedItemsService.scanOut(
      technicianId,
      item.serialNumber,
      customerName,
      referenceNumber,
      undefined,
      undefined,
      ctx ? unwrapInventoryTransactionContext(ctx) : undefined
    );

    return true;
  }
}
