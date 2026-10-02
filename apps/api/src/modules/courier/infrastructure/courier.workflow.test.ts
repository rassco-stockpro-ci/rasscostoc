import { describe, it, expect, vi, beforeEach } from "vitest";
import { CourierWorkflow } from "../application/workflow/courier.workflow";
import { WorkflowDecision } from "../application/workflow/workflow.types";
import { EventBus } from "@core/events/event-bus";
import { ExecutionCompletedEvent, InventoryDeductionFailedEvent } from "@core/events/events";
import { InventorySubscriber } from "../../inventory/contracts";
import { CourierAuditSubscriber } from "./subscribers/courier-audit.subscriber";
import { CourierSagaSubscriber } from "./subscribers/courier-saga.subscriber";

const mockDeduct = vi.fn();
const { mockSelect, mockInsert, mockUpdate, mockDelete } = vi.hoisted(() => {
  let queriedTable: any = null;
  const selectQuery: any = {
    from: vi.fn().mockImplementation((t) => {
      queriedTable = t;
      return selectQuery;
    }),
    where: vi.fn().mockImplementation(() => {
      const getResults = () => {
        const tableName = queriedTable?.key?.name || "";
        if (tableName === "idempotency_records") {
          return [];
        }
        // No completion row: these events model a legacy close whose
        // deduction has not run, which InventorySubscriber still performs.
        if (queriedTable?.[Symbol.for("drizzle:Name")] === "inventory_deduction_completions") {
          return [];
        }
        if (tableName === "courier_request_items") {
          return [
            {
              id: 1,
              requestId: 789,
              status: "RECEIVED",
              itemType: "POS",
              serialNumber: "DEV_SERIAL_1",
              simSerial: "SIM_SERIAL_1"
            }
          ];
        }
        return [{ id: "tech-1", username: "TECH_001", role: "technician", regionId: null }];
      };

      const promise = Promise.resolve(getResults());
      return {
        limit: vi.fn().mockImplementation(() => Promise.resolve(getResults())),
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
      };
    }),
  };

  return {
    mockSelect: vi.fn().mockImplementation((table?: any) => {
      queriedTable = table;
      return selectQuery;
    }),
    mockInsert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockResolvedValue([{ id: 1 }]),
    })),
    mockUpdate: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          const queryPromise = Promise.resolve([{ id: 1 }]);
          return {
            returning: vi.fn().mockResolvedValue([{ id: 1 }]),
            then: queryPromise.then.bind(queryPromise),
            catch: queryPromise.catch.bind(queryPromise),
          };
        }),
      })),
    })),
    mockDelete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockResolvedValue([{ id: 1 }]),
    }))
  };
});

// Mock the entire InventoryEngine module to intercept all imports
vi.mock("../application/inventory/inventory.engine", () => {
  return {
    InventoryEngine: vi.fn().mockImplementation(() => ({
      deduct: mockDeduct,
    })),
  };
});

// Mock database to avoid hitting PostgreSQL in unit/integration tests
vi.mock("@server/core/config/db", () => {
  return {
    db: {
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      delete: mockDelete,
      transaction: vi.fn().mockImplementation((cb) => cb({ 
        select: mockSelect, 
        insert: mockInsert,
        update: mockUpdate,
        delete: mockDelete
      })),
    },
    pool: {},
  };
});

describe("CourierWorkflow & EventBus Decoupled Integration Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Clear all listeners from the EventBus to avoid duplicated runs
    const eventBus = EventBus.getInstance();
    (eventBus as any).emitter.removeAllListeners();
  });

  describe("CourierWorkflow Decisions", () => {
    it("should decide TRIGGER_INVENTORY_DEDUCTION for 'Installation Completed'", () => {
      const decision = CourierWorkflow.decide("Installation Completed");
      expect(decision).toBe(WorkflowDecision.TRIGGER_INVENTORY_DEDUCTION);
    });

    it("should decide CLOSE_WITHOUT_DEDUCTION for 'Cancelled'", () => {
      const decision = CourierWorkflow.decide("Cancelled");
      expect(decision).toBe(WorkflowDecision.CLOSE_WITHOUT_DEDUCTION);
    });

    it("should decide MARK_IN_PROGRESS for 'In Progress'", () => {
      const decision = CourierWorkflow.decide("In Progress");
      expect(decision).toBe(WorkflowDecision.MARK_IN_PROGRESS);
    });

    it("should decide UNKNOWN for empty or unrecognized status", () => {
      const decision = CourierWorkflow.decide("Some Invalid Status");
      expect(decision).toBe(WorkflowDecision.UNKNOWN);
    });
  });

  describe("Workflow Execution & Event Publishing", () => {
    it("should publish ExecutionCompletedEvent when status is Completed", async () => {
      const eventBus = EventBus.getInstance();
      const publishSpy = vi.spyOn(eventBus, "publish");

      const ctx = {
        requestId: 456,
        actorId: "user-1",
        execution: {
          installationStatus: "Installation Completed",
          sn: "DEV123",
          simSerial: "SIM999",
          technicianCode: "TECH_001",
        },
        request: {
          id: 456,
          customerName: "Jane Doe",
          vendorType: "Geidea",
          tecName: "TECH_001",
        },
      };

      const result = await CourierWorkflow.execute(ctx);

      expect(result.decision).toBe(WorkflowDecision.TRIGGER_INVENTORY_DEDUCTION);
      expect(result.inventoryDeducted).toBe(true);

      // Verify that ExecutionCompletedEvent was published to the EventBus
      expect(publishSpy).toHaveBeenCalled();
      const publishedEvent = publishSpy.mock.calls[0][0] as any;
      expect(publishedEvent).toBeInstanceOf(ExecutionCompletedEvent);
      expect(publishedEvent.payload.requestId).toBe(456);
      expect(publishedEvent.payload.actorId).toBe("user-1");
    });
  });

  describe("Event-Driven Subscriber Chain", () => {
    it("should propagate ExecutionCompletedEvent to InventorySubscriber and deduct inventory", () => {
      return new Promise<void>((resolve) => {
        const eventBus = EventBus.getInstance();

        mockDeduct.mockResolvedValue({
          requestId: 789,
          generalInventoryDeducted: true,
          custodyItemsDeducted: ["DEV_SERIAL_1"],
          errors: [],
        });

        // Register subscribers
        InventorySubscriber.register();
        CourierAuditSubscriber.register();

        const testEvent = new ExecutionCompletedEvent({
          requestId: 789,
          actorId: "supervisor-1",
          execution: {
            installationStatus: "Installation Completed",
            sn: "DEV_SERIAL_1",
            extraField1: "",
            extraField2: "",
            simSerial: "SIM_SERIAL_1",
            technicianCode: "TECH_001",
          },
          request: {
            id: 789,
            customerName: "Test Customer",
            incidentNumber: "INC-789",
            vendorType: "Geidea",
            tecName: "TECH_001",
          },
        });

        // Publish event
        eventBus.publish(testEvent);

        // Allow microtask queue / setTimeout to process the event
        setTimeout(() => {
          // Verify that InventoryEngine.deduct was called with correct parameters
          expect(mockDeduct).toHaveBeenCalledWith(
            expect.objectContaining({
              requestId: 789,
              technicianCode: "TECH_001",
              customerName: "Test Customer",
            })
          );
          resolve();
        }, 50);

      });
    });

    it("should publish InventoryDeductionFailedEvent if repository fails", () => {
      return new Promise<void>((resolve) => {
        const eventBus = EventBus.getInstance();
        const publishSpy = vi.spyOn(eventBus, "publish");

        mockDeduct.mockResolvedValue({
          requestId: 999,
          generalInventoryDeducted: false,
          custodyItemsDeducted: [],
          errors: ["حالة الجهاز ليست IN_TRANSIT_CUSTODY أو لا يخص الفني"],
        });

        InventorySubscriber.register();

        const testEvent = new ExecutionCompletedEvent({
          requestId: 999,
          actorId: "tech-1",
          execution: {
            installationStatus: "Installation Completed",
            sn: "DEV_FAILED_SERIAL",
            simSerial: "SIM_FAILED_SERIAL",
            technicianCode: "TECH_002",
          },
          request: {
            id: 999,
            customerName: "Failed Custody Customer",
            incidentNumber: "INC-999",
            vendorType: "Geidea",
            tecName: "TECH_002",
          },
        });

        eventBus.publish(testEvent);

        setTimeout(() => {
          // Check that InventoryDeductionFailedEvent was published
          const failedEventCall = publishSpy.mock.calls.find(
            (call) => call[0] instanceof InventoryDeductionFailedEvent
          );
          expect(failedEventCall).toBeDefined();
          const failedEvent = failedEventCall![0] as InventoryDeductionFailedEvent;
          expect(failedEvent.payload.requestId).toBe(999);
          expect(failedEvent.payload.errors.length).toBeGreaterThan(0);
          expect(failedEvent.payload.errors[0]).toContain("حالة الجهاز ليست IN_TRANSIT_CUSTODY أو لا يخص الفني");
          resolve();
        }, 50);

      });
    });

    it("should execute compensating transaction (Saga) via CourierSagaSubscriber on InventoryDeductionFailedEvent", () => {
      return new Promise<void>((resolve) => {
        const eventBus = EventBus.getInstance();

        // Register Saga Subscriber
        CourierSagaSubscriber.register();

        const failedEvent = new InventoryDeductionFailedEvent({
          requestId: 999,
          actorId: "tech-1",
          technicianCode: "TECH_002",
          errors: ["الرقم التسلسلي غير موجود في عهدة الفني"],
        });

        eventBus.publish(failedEvent);

        setTimeout(() => {
          // Verify that db.update was triggered to revert status
          expect(mockUpdate).toHaveBeenCalled();
          // Verify that db.insert was triggered to log audit trail
          expect(mockInsert).toHaveBeenCalled();
          resolve();
        }, 50);
      });
    });
  });
});
