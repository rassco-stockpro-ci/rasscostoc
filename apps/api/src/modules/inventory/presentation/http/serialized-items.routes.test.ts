import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { registerSerializedItemsRoutes } from "../routes/serialized-items.routes";
import { serializedItemsContainer } from "@server/composition/serialized-items.container";
import { errorHandler } from "../../../../core/errors/errorHandler";

// Mock the authentication middleware
vi.mock("@core/middlewares/auth.middleware", () => {
  return {
    requireAuth: (req: any, res: any, next: any) => {
      req.user = { id: "test-tech-id-123", username: "testtech", role: "technician" };
      next();
    },
    // TEMP-SYSTEM-STABILIZATION: added when PATCH/DELETE /api/serialized-items/:id
    // (admin-only routes) were introduced — route registration itself needs this
    // export to exist, even though no test in this file exercises those routes.
    requireAdmin: (req: any, res: any, next: any) => {
      if (req.user?.role === "admin") return next();
      return res.status(403).json({ success: false, message: "Admin access required" });
    },
  };
});

// Mock SerializedItemsService before container is loaded
vi.mock("@modules/inventory/infrastructure/services/serialized-items.service", () => {
  const scanInMock = vi.fn();
  const scanOutMock = vi.fn();
  const lookupMock = vi.fn();
  const deleteFromTechnicianCustodyMock = vi.fn();

  return {
    SerializedItemsService: class {
      scanIn = scanInMock;
      scanOut = scanOutMock;
      lookup = lookupMock;
      deleteFromTechnicianCustody = deleteFromTechnicianCustodyMock;
    },
    serializedItemsService: {
      scanIn: scanInMock,
      scanOut: scanOutMock,
      lookup: lookupMock,
      deleteFromTechnicianCustody: deleteFromTechnicianCustodyMock,
    }
  };
});

// TEMPORARY FEATURE — remove or disable after final customer handover.
const isTechnicianCustodyDeleteEnabledMock = vi.fn(() => true);
vi.mock("../../config/technician-custody-delete.flag", () => ({
  isTechnicianCustodyDeleteEnabled: () => isTechnicianCustodyDeleteEnabledMock(),
}));

describe("Serialized Items HTTP Integration Tests", () => {
  let app: express.Express;
  const mockSerializedItemsService = serializedItemsContainer.serializedItemsService;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    registerSerializedItemsRoutes(app);
    app.use(errorHandler);
    vi.clearAllMocks();
  });

  describe("POST /api/serialized-items/scan-in", () => {
    it("should successfully register custody scan-in and return 200", async () => {
      const mockResult = {
        id: "item-uuid-111",
        serialNumber: "SN-DEVICE-777",
        status: "IN_TRANSIT_CUSTODY",
        currentOwnerId: "test-tech-id-123",
      };

      vi.mocked(mockSerializedItemsService.scanIn).mockResolvedValue(mockResult as any);

      const res = await request(app)
        .post("/api/serialized-items/scan-in")
        .send({
          serialNumber: "SN-DEVICE-777",
          itemTypeId: "device-type-pos",
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(mockResult);
      expect(mockSerializedItemsService.scanIn).toHaveBeenCalledWith(
        "test-tech-id-123",
        "SN-DEVICE-777",
        "device-type-pos",
        undefined,
        undefined
      );
    });

    it("should return 400 validation error if serialNumber is missing", async () => {
      await request(app)
        .post("/api/serialized-items/scan-in")
        .send({
          itemTypeId: "device-type-pos",
        })
        .expect(400);

      expect(mockSerializedItemsService.scanIn).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/serialized-items/scan-out", () => {
    it("should successfully register scan-out and return 200", async () => {
      const mockResult = {
        id: "item-uuid-111",
        serialNumber: "SN-DEVICE-777",
        status: "DELIVERED",
        currentOwnerId: null,
      };

      vi.mocked(mockSerializedItemsService.scanOut).mockResolvedValue(mockResult as any);

      const res = await request(app)
        .post("/api/serialized-items/scan-out")
        .send({
          serialNumber: "SN-DEVICE-777",
          receiverName: "Ahmed Ali",
          orderNumber: "ORD-9988",
          latitude: 24.7136,
          longitude: 46.6753,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(mockResult);
      expect(mockSerializedItemsService.scanOut).toHaveBeenCalledWith(
        "test-tech-id-123",
        "SN-DEVICE-777",
        "Ahmed Ali",
        "ORD-9988",
        24.7136,
        46.6753
      );
    });

    it("should return 400 validation error if receiverName is missing", async () => {
      await request(app)
        .post("/api/serialized-items/scan-out")
        .send({
          serialNumber: "SN-DEVICE-777",
          orderNumber: "ORD-9988",
        })
        .expect(400);

      expect(mockSerializedItemsService.scanOut).not.toHaveBeenCalled();
    });

    // OPS-REMED-E3-I.R2: the standalone HTTP endpoint must keep operating
    // exactly as before — it never has (and must never be given) an E3
    // transaction context. serialized-items.service.ts's scanOut() opens
    // its own independent db.transaction() whenever externalTx is absent
    // (see runBody / externalTx branch), which is exactly what happens
    // when the controller calls it with no 7th argument, as asserted here.
    it("OPS-REMED-E3: calls scanOut with NO external transaction context — the endpoint opens its own transaction, unaffected by the E3 courier deduction path", async () => {
      const mockResult = {
        id: "item-uuid-111",
        serialNumber: "SN-DEVICE-777",
        status: "DELIVERED",
        currentOwnerId: null,
      };
      vi.mocked(mockSerializedItemsService.scanOut).mockResolvedValue(mockResult as any);

      await request(app)
        .post("/api/serialized-items/scan-out")
        .send({
          serialNumber: "SN-DEVICE-777",
          receiverName: "Ahmed Ali",
          orderNumber: "ORD-9988",
        })
        .expect(200);

      const call = vi.mocked(mockSerializedItemsService.scanOut).mock.calls[0]!;
      // Exactly 5 positional arguments (technicianId, serialNumber,
      // receiverName, orderNumber, latitude=undefined — no
      // longitude/externalTx supplied) — no 7th "external context" arg is
      // ever passed by this standalone caller.
      expect(call.length).toBeLessThanOrEqual(6);
      expect(call[6]).toBeUndefined();
    });
  });

  describe("GET /api/serialized-items/lookup/:serialNumber", () => {
    it("should return 200 and device custody history logs if item exists", async () => {
      const mockLookupResult = {
        id: "item-uuid-111",
        serialNumber: "SN-DEVICE-777",
        status: "DELIVERED",
        carrierName: "STC",
        createdAt: "2026-06-25T00:00:00Z",
        itemTypeNameAr: "شريحة اتصال STC",
        ownerName: "الفني المختص",
        ownerUsername: "tech1",
        history: [
          {
            id: "log-uuid-1",
            fromStatus: "NONE",
            toStatus: "IN_TRANSIT_CUSTODY",
            changedAt: "2026-06-25T00:05:00Z",
            notes: "استلام عهدة أولية",
            changedByName: "فني الاختبار",
          },
        ],
      };

      vi.mocked(mockSerializedItemsService.lookup).mockResolvedValue(mockLookupResult as any);

      const res = await request(app)
        .get("/api/serialized-items/lookup/SN-DEVICE-777")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(mockLookupResult);
      expect(mockSerializedItemsService.lookup).toHaveBeenCalledWith("SN-DEVICE-777");
    });

    it("should return 404 error if item is not found", async () => {
      vi.mocked(mockSerializedItemsService.lookup).mockResolvedValue(null);

      const res = await request(app)
        .get("/api/serialized-items/lookup/SN-DEVICE-UNKNOWN")
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("المادة غير مسجلة");
    });
  });

  // TEMPORARY FEATURE — remove or disable after final customer handover.
  describe("DELETE /api/inventory/my-custody/items/:itemType/:serialNumber", () => {
    beforeEach(() => {
      isTechnicianCustodyDeleteEnabledMock.mockReturnValue(true);
    });

    it("deletes a DEVICE from the authenticated technician's own custody and returns 200", async () => {
      vi.mocked(mockSerializedItemsService.deleteFromTechnicianCustody).mockResolvedValue({
        itemType: "DEVICE",
        serialNumber: "SN-DEVICE-777",
        deleted: true,
        alreadyDeleted: false,
      } as any);

      const res = await request(app)
        .delete("/api/inventory/my-custody/items/DEVICE/SN-DEVICE-777")
        .send({ confirmation: "SN-DEVICE-777" })
        .expect(200);

      expect(res.body).toMatchObject({
        success: true,
        itemType: "DEVICE",
        serialNumber: "SN-DEVICE-777",
        deleted: true,
        removedFromCustody: true,
        productPreserved: true,
        inventoryRecalculated: true,
      });

      // Identity comes only from the mocked req.user set by requireAuth above —
      // never from the request body.
      expect(mockSerializedItemsService.deleteFromTechnicianCustody).toHaveBeenCalledWith(
        "test-tech-id-123",
        "testtech",
        "technician",
        "DEVICE",
        "SN-DEVICE-777",
        "SN-DEVICE-777",
        undefined
      );
    });

    it("deletes a SIM from the authenticated technician's own custody and returns 200", async () => {
      vi.mocked(mockSerializedItemsService.deleteFromTechnicianCustody).mockResolvedValue({
        itemType: "SIM",
        serialNumber: "89966020000000123456",
        deleted: true,
        alreadyDeleted: false,
      } as any);

      const res = await request(app)
        .delete("/api/inventory/my-custody/items/SIM/89966020000000123456")
        .send({
          confirmation: "89966020000000123456",
          reason: "temporary_cleanup_before_customer_handover",
        })
        .expect(200);

      expect(res.body).toMatchObject({ success: true, itemType: "SIM", deleted: true });
      expect(mockSerializedItemsService.deleteFromTechnicianCustody).toHaveBeenCalledWith(
        "test-tech-id-123",
        "testtech",
        "technician",
        "SIM",
        "89966020000000123456",
        "89966020000000123456",
        "temporary_cleanup_before_customer_handover"
      );
    });

    it("ignores a technicianId/ownerId supplied in the request body", async () => {
      vi.mocked(mockSerializedItemsService.deleteFromTechnicianCustody).mockResolvedValue({
        itemType: "DEVICE",
        serialNumber: "SN-DEVICE-777",
        deleted: true,
        alreadyDeleted: false,
      } as any);

      await request(app)
        .delete("/api/inventory/my-custody/items/DEVICE/SN-DEVICE-777")
        .send({
          confirmation: "SN-DEVICE-777",
          technicianId: "attacker-controlled-id",
          ownerId: "attacker-controlled-id",
          userId: "attacker-controlled-id",
        })
        .expect(200);

      expect(mockSerializedItemsService.deleteFromTechnicianCustody).toHaveBeenCalledWith(
        "test-tech-id-123", // from req.user, not from the body
        "testtech",
        "technician",
        "DEVICE",
        "SN-DEVICE-777",
        "SN-DEVICE-777",
        undefined
      );
    });

    it("returns 400 for an itemType other than DEVICE/SIM and never calls the service", async () => {
      await request(app)
        .delete("/api/inventory/my-custody/items/TABLET/SN-DEVICE-777")
        .send({ confirmation: "SN-DEVICE-777" })
        .expect(400);

      expect(mockSerializedItemsService.deleteFromTechnicianCustody).not.toHaveBeenCalled();
    });

    it("returns 400 when confirmation is missing", async () => {
      await request(app)
        .delete("/api/inventory/my-custody/items/DEVICE/SN-DEVICE-777")
        .send({})
        .expect(400);

      expect(mockSerializedItemsService.deleteFromTechnicianCustody).not.toHaveBeenCalled();
    });

    it("propagates 403 ITEM_NOT_IN_YOUR_CUSTODY from the service", async () => {
      const { AppError } = await import("@core/errors/AppError");
      vi.mocked(mockSerializedItemsService.deleteFromTechnicianCustody).mockRejectedValue(
        new AppError("لا يمكنك حذف عنصر غير موجود في عهدتك", 403, true, "ITEM_NOT_IN_YOUR_CUSTODY")
      );

      const res = await request(app)
        .delete("/api/inventory/my-custody/items/DEVICE/SN-DEVICE-777")
        .send({ confirmation: "SN-DEVICE-777" })
        .expect(403);

      expect(res.body).toMatchObject({ success: false, code: "ITEM_NOT_IN_YOUR_CUSTODY" });
    });

    it("propagates 409 ITEM_HAS_ACTIVE_RELATIONS from the service", async () => {
      const { AppError } = await import("@core/errors/AppError");
      vi.mocked(mockSerializedItemsService.deleteFromTechnicianCustody).mockRejectedValue(
        new AppError("لا يمكن حذف العنصر لارتباطه بعملية نشطة", 409, true, "ITEM_HAS_ACTIVE_RELATIONS")
      );

      const res = await request(app)
        .delete("/api/inventory/my-custody/items/DEVICE/SN-DEVICE-777")
        .send({ confirmation: "SN-DEVICE-777" })
        .expect(409);

      expect(res.body).toMatchObject({ success: false, code: "ITEM_HAS_ACTIVE_RELATIONS" });
    });

    it("returns 404 and never calls the service when the feature flag is disabled", async () => {
      isTechnicianCustodyDeleteEnabledMock.mockReturnValue(false);

      await request(app)
        .delete("/api/inventory/my-custody/items/DEVICE/SN-DEVICE-777")
        .send({ confirmation: "SN-DEVICE-777" })
        .expect(404);

      expect(mockSerializedItemsService.deleteFromTechnicianCustody).not.toHaveBeenCalled();
    });
  });
});
