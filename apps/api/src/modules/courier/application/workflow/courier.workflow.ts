/**
 * CourierWorkflow — Workflow Engine (State Machine)
 *
 * Sole responsibility: decide what action to take based on the installation status.
 * Then delegate execution of that action to the appropriate handler.
 *
 * Rules:
 * - Does NOT validate data (Guards do that).
 * - Does NOT know how inventory deduction works internally.
 * - Does NOT direct call inventory services (publishes ExecutionCompletedEvent instead).
 * - Is the ONLY place where status-to-action mapping is defined.
 */

import { WorkflowDecision, type WorkflowContext, type WorkflowResult } from "./workflow.types";
import { isCompletedStatus } from "../guards/CompletionGuard";
import { EventBus } from "@core/events/event-bus";
import { ExecutionCompletedEvent } from "@core/events/events";
import { tracer } from "@core/telemetry/tracer";

/** Statuses that close without inventory deduction */
const CLOSE_WITHOUT_DEDUCTION_STATUSES = new Set([
  "Not Completed",
  "Customer Not Answering",
  "Cancelled",
]);

/** Statuses that mark as in-progress, no terminal action */
const IN_PROGRESS_STATUSES = new Set([
  "In Progress",
  "Pending",
  "Rescheduled",
]);

export class CourierWorkflow {
  /**
   * Execute the workflow for a saved execution.
   * Called AFTER guards pass and execution is written to DB.
   */
  static async execute(ctx: WorkflowContext): Promise<WorkflowResult> {
    const { requestId, actorId, execution } = ctx;
    const status = execution.installationStatus ?? "";

    const span = tracer.startSpan("WorkflowExecution", { requestId, actorId, status });

    try {
      const decision = CourierWorkflow.decide(status);

      const result: WorkflowResult = {
        decision,
        requestId,
        actorId,
        inventoryDeducted: false,
        sideEffectErrors: [],
      };

      switch (decision) {
        case WorkflowDecision.TRIGGER_INVENTORY_DEDUCTION:
          await CourierWorkflow.handleInventoryDeduction(ctx, result);
          break;

        case WorkflowDecision.CLOSE_WITHOUT_DEDUCTION:
          // No inventory action — future: emit RequestClosedEvent
          console.log(`[Workflow] Request ${requestId} closed without deduction. Status: ${status}`);
          break;

        case WorkflowDecision.MARK_IN_PROGRESS:
          // No terminal action — future: schedule follow-up
          console.log(`[Workflow] Request ${requestId} marked in-progress. Status: ${status}`);
          break;

        case WorkflowDecision.UNKNOWN:
          console.warn(`[Workflow] Unrecognized status "${status}" for request ${requestId}. No action taken.`);
          break;
      }

      return result;
    } finally {
      span.end();
    }
  }

  /**
   * Pure decision function — maps installation status to WorkflowDecision.
   * All status-to-action mappings live HERE and nowhere else.
   */
  static decide(status: string): WorkflowDecision {
    if (isCompletedStatus(status)) {
      return WorkflowDecision.TRIGGER_INVENTORY_DEDUCTION;
    }
    if (CLOSE_WITHOUT_DEDUCTION_STATUSES.has(status)) {
      return WorkflowDecision.CLOSE_WITHOUT_DEDUCTION;
    }
    if (IN_PROGRESS_STATUSES.has(status)) {
      return WorkflowDecision.MARK_IN_PROGRESS;
    }
    if (status.trim() !== "") {
      return WorkflowDecision.UNKNOWN;
    }
    return WorkflowDecision.UNKNOWN;
  }

  /**
   * Handle the TRIGGER_INVENTORY_DEDUCTION decision.
   * Publishes ExecutionCompletedEvent to decouple inventory deduction from workflow logic.
   */
  private static async handleInventoryDeduction(
    ctx: WorkflowContext,
    result: WorkflowResult
  ): Promise<void> {
    const { requestId, actorId, execution, request } = ctx;

    const eventBus = EventBus.getInstance();

    try {
      await eventBus.publish(
        new ExecutionCompletedEvent({
          requestId,
          actorId,
          execution,
          request,
        })
      );
      result.inventoryDeducted = true;
    } catch (err: any) {
      // The execution was already committed to DB before this workflow runs.
      // A failure here (e.g. synchronous subscriber error via publishLocal fallback)
      // must NOT surface as HTTP 500 — the saga subscriber already published
      // InventoryDeductionFailedEvent to compensate. Log and continue.
      const msg = err?.message || "Failed to dispatch ExecutionCompletedEvent";
      console.error(`[Workflow] handleInventoryDeduction error for request ${requestId}:`, err);
      result.sideEffectErrors.push(msg);
    }
  }
}
