import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../../../core/config/db";
import { courierRequests, courierExecutions, users } from "@shared/schema";
import { createInventoryEngine } from "../composition/courier.container";
import { CourierService } from "../application/courier.service";
import { DrizzleCourierRepository } from "./repositories/drizzle-courier.repository";
import { DrizzleCourierUnitOfWork } from "./repositories/DrizzleCourierUnitOfWork";
import { eq } from "drizzle-orm";
import { OptimisticLockException } from "@core/errors/AppError";

describe("Courier Optimistic Locking Integration Tests", () => {
  const repo = new DrizzleCourierRepository();
  const service = new CourierService(
    new DrizzleCourierUnitOfWork(),
    repo, repo, repo, repo, repo, createInventoryEngine()
  );
  let userId: string;

  beforeEach(async () => {
    // Clear executions and requests before each test to start clean
    await db.delete(courierExecutions);
    await db.delete(courierRequests);

    // Create a test user to satisfy foreign key constraints
    const testUsername = "locking_test_user";
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.username, testUsername))
      .limit(1);

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const [insertedUser] = await db
        .insert(users)
        .values({
          id: "locking-test-user-id",
          username: testUsername,
          email: "locking-test@stockpro.com",
          password: "test-password",
          fullName: "Locking Test User",
          role: "technician",
        })
        .returning();
      userId = insertedUser.id;
    }
  });

  describe("courier_requests Locking", () => {
    it("should successfully update when version matches and increment version by 1", async () => {
      // 1. Create a request (default version is 1)
      const [req] = await db
        .insert(courierRequests)
        .values({
          customerName: "Initial Customer",
          incidentNumber: "INC-101",
          createdBy: userId,
        })
        .returning();

      expect(req.version).toBe(1);

      // 2. Perform a valid update (sending expected version = 1)
      const updated = await service.updateRequest(
        req.id,
        {
          customerName: "Updated Customer Name",
          version: 1,
        },
        userId
      );

      expect(updated).toBeDefined();
      expect(updated.customerName).toBe("Updated Customer Name");
      expect(updated.version).toBe(2); // Should increment in DB
    });

    it("should throw OptimisticLockException when concurrent update occurs with stale version", async () => {
      // 1. Create request
      const [req] = await db
        .insert(courierRequests)
        .values({
          customerName: "Concurrent Customer",
          incidentNumber: "INC-102",
          createdBy: userId,
        })
        .returning();

      expect(req.version).toBe(1);

      // Simulate User A fetching the request (version=1)
      const userAVersion = req.version;
      // Simulate User B fetching the request (version=1)
      const userBVersion = req.version;

      // 2. User A updates first -> succeeds
      await service.updateRequest(
        req.id,
        {
          customerName: "User A Title",
          version: userAVersion,
        },
        userId
      );

      // 3. User B tries to update with stale version -> must throw OptimisticLockException (409)
      await expect(
        service.updateRequest(
          req.id,
          {
            customerName: "User B Title",
            version: userBVersion,
          },
          userId
        )
      ).rejects.toThrow(OptimisticLockException);
    });

    it("should recover and update successfully after reading the latest version", async () => {
      // 1. Create request
      const [req] = await db
        .insert(courierRequests)
        .values({
          customerName: "Recovery Customer",
          incidentNumber: "INC-103",
          createdBy: userId,
        })
        .returning();

      // User A and User B both get version 1
      const userAVersion = req.version;

      // User A updates
      await service.updateRequest(
        req.id,
        {
          customerName: "User A Edit",
          version: userAVersion,
        },
        userId
      );

      // User B tries to update with stale version 1 -> Fails
      let errorThrown: any = null;
      try {
        await service.updateRequest(
          req.id,
          {
            customerName: "User B Edit",
            version: userAVersion,
          },
          userId
        );
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(OptimisticLockException);

      // 2. User B reads latest request from DB
      const latestReq = await service.getRequestById(req.id);
      expect(latestReq.version).toBe(2);

      // 3. User B retries update with latest version -> succeeds!
      const successfulUpdate = await service.updateRequest(
        req.id,
        {
          customerName: "User B Edit Success",
          version: latestReq.version,
        },
        userId
      );

      expect(successfulUpdate.customerName).toBe("User B Edit Success");
      expect(successfulUpdate.version).toBe(3);
    });
  });

  describe("courier_executions Locking", () => {
    it("should successfully update and increment execution version when version matches", async () => {
      // 1. Create request
      const [req] = await db
        .insert(courierRequests)
        .values({
          customerName: "Execution Customer",
          incidentNumber: "INC-201",
          createdBy: userId,
        })
        .returning();

      // 2. Save first execution (insert)
      const execution = await service.saveExecution(
        req.id,
        {
          installationStatus: "Pending",
        },
        userId
      );
      expect(execution.execution.version).toBe(1);

      // 3. Save second execution (update) with version 1
      const updatedExecution = await service.saveExecution(
        req.id,
        {
          installationStatus: "In Progress",
          version: 1,
        },
        userId
      );

      expect(updatedExecution.execution.installationStatus).toBe("In Progress");
      expect(updatedExecution.execution.version).toBe(2);
    });

    it("should throw OptimisticLockException when concurrent execution update occurs", async () => {
      // 1. Create request and initial execution
      const [req] = await db
        .insert(courierRequests)
        .values({
          customerName: "Execution Concurrent",
          incidentNumber: "INC-202",
          createdBy: userId,
        })
        .returning();

      const initialExec = await service.saveExecution(
        req.id,
        {
          installationStatus: "Pending",
        },
        userId
      );
      expect(initialExec.execution.version).toBe(1);

      // User A and User B read version 1
      const userAVersion = initialExec.execution.version;
      const userBVersion = initialExec.execution.version;

      // User A updates
      await service.saveExecution(
        req.id,
        {
          installationStatus: "In Progress",
          version: userAVersion,
        },
        userId
      );

      // User B tries to update with stale version -> throws 409
      await expect(
        service.saveExecution(
          req.id,
          {
            installationStatus: "In Progress",
            version: userBVersion,
          },
          userId
        )
      ).rejects.toThrow(OptimisticLockException);
    });
  });
});
