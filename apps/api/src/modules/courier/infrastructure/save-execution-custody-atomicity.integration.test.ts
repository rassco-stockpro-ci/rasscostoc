/**
 * Governance regression: CompletionGuard auto-bind must be transactionally
 * coupled to execution persistence.
 *
 * Scenario:
 * - a completed execution references a real custody item,
 * - CompletionGuard auto-binds a missing courier_request_items row,
 * - execution persistence is intentionally forced to fail via a stale version,
 * - the auto-bind MUST roll back with the failed UnitOfWork.
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../../core/config/db";
import {
  users,
  itemTypes,
  items,
  courierRequests,
  courierRequestItems,
  courierExecutions,
  inventoryTransactions,
  itemHistoryLogs,
  custodyMovements,
  technicianMovingInventoryEntries,
} from "@shared/schema";
import { CourierService } from "../application/courier.service";
import { DrizzleCourierRepository } from "./repositories/drizzle-courier.repository";
import { DrizzleCourierUnitOfWork } from "./repositories/DrizzleCourierUnitOfWork";
import { OptimisticLockException } from "@core/errors/AppError";

describe("Governance — CompletionGuard/UoW atomicity", () => {
  const created: {
    userId?: string;
    itemTypeId?: string;
    itemId?: string;
    requestId?: number;
  } = {};

  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database."
      );
    }
  });

  afterEach(async () => {
    if (created.requestId) {
      await db.delete(courierRequestItems).where(eq(courierRequestItems.requestId, created.requestId)).catch(() => {});
      await db.delete(courierExecutions).where(eq(courierExecutions.requestId, created.requestId)).catch(() => {});
      await db.delete(courierRequests).where(eq(courierRequests.id, created.requestId)).catch(() => {});
    }
    if (created.itemId) {
      await db.delete(inventoryTransactions).where(eq(inventoryTransactions.itemId, created.itemId)).catch(() => {});
      await db.delete(itemHistoryLogs).where(eq(itemHistoryLogs.itemId, created.itemId)).catch(() => {});
      await db.delete(custodyMovements).where(eq(custodyMovements.itemId, created.itemId)).catch(() => {});
      await db.delete(items).where(eq(items.id, created.itemId)).catch(() => {});
    }
    if (created.itemTypeId) {
      await db.delete(itemTypes).where(eq(itemTypes.id, created.itemTypeId)).catch(() => {});
    }
    if (created.userId) {
      await db.delete(users).where(eq(users.id, created.userId)).catch(() => {});
    }
    created.userId = undefined;
    created.itemTypeId = undefined;
    created.itemId = undefined;
    created.requestId = undefined;
  });

  it("rolls back CustodyGuard auto-binding when execution save loses its optimistic lock", async () => {
    const userId = randomUUID();
    const itemTypeId = randomUUID();
    const itemId = randomUUID();

    created.userId = userId;
    created.itemTypeId = itemTypeId;
    created.itemId = itemId;

    await db.insert(users).values({
      id: userId,
      username: `gov-atomic-${userId.slice(0, 8)}`,
      email: `gov-atomic-${userId.slice(0, 8)}@test.local`,
      password: "x",
      fullName: "Governance Atomicity Technician",
      role: "technician",
    });

    await db.insert(itemTypes).values({
      id: itemTypeId,
      nameAr: "Governance Atomic Type",
      nameEn: "Governance Atomic Type",
      category: "devices",
      isActive: true,
      requiresSerial: true,
      serialPrefix: "QA",
      serialLength: 12,
      serialRegex: "^QA[0-9]{10}$",
    });

    const serial = `QA${randomUUID().replace(/-/g, "").slice(0, 10)}`.toUpperCase();

    await db.insert(items).values({
      id: itemId,
      itemTypeId,
      serialNumber: serial,
      barcode: serial,
      status: "RECEIVED_BY_TECHNICIAN",
      currentOwnerId: userId,
    });

    const [request] = await db
      .insert(courierRequests)
      .values({
        customerName: "Governance Atomicity Request",
        incidentNumber: `GOV-ATOMIC-${randomUUID().slice(0, 8)}`,
      })
      .returning();

    created.requestId = request.id;

    await db.insert(courierExecutions).values({
      requestId: request.id,
      enteredBy: userId,
      installationStatus: "Installation Completed - NL",
      custodyClosureStatus: "PENDING_DEDUCTION",
      version: 1,
    });

    const service = new CourierService(
      new DrizzleCourierUnitOfWork(),
      new DrizzleCourierRepository(),
      new DrizzleCourierRepository(),
      new DrizzleCourierRepository(),
      new DrizzleCourierRepository(),
      new DrizzleCourierRepository()
    );

    await expect(
      service.saveExecution(
        request.id,
        {
          installationStatus: "Installation Completed - NL",
          sn: serial,
          technicianCode: `gov-atomic-${userId.slice(0, 8)}`,
          version: 0,
        },
        userId
      )
    ).rejects.toBeInstanceOf(OptimisticLockException);

    const boundRows = await db
      .select()
      .from(courierRequestItems)
      .where(
        and(
          eq(courierRequestItems.requestId, request.id),
          eq(courierRequestItems.serialNumber, serial)
        )
      );

    expect(boundRows).toHaveLength(0);

    const [execution] = await db
      .select()
      .from(courierExecutions)
      .where(eq(courierExecutions.requestId, request.id));

    expect(execution?.version).toBe(1);
  });
});
