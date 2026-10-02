/**
 * InventoryEngine
 *
 * Sole responsibility: execute inventory deduction operations.
 *
 * Rules:
 * - Knows NOTHING about courier requests, workflow decisions, or installation statuses.
 * - Depends on IGeneralInventoryRepository and ISerializedInventoryRepository (interfaces).
 * - Is the ONLY place where inventory deduction orchestration lives.
 *
 * OPS-REMED-E3 (implemented):
 * - deduct() opens ONE request-wide transaction via the injected
 *   IInventoryTransactionRunner, spanning every serialized-custody and
 *   general-inventory write. Any failure rolls back everything.
 * - Deduction failures THROW a structured DeductionError instead of being
 *   silently swallowed into a `{success:false}`-shaped result — this is
 *   required so the idempotency layer correctly marks FAILED (not
 *   COMPLETED) and the existing outbox retry/dead-letter machinery engages.
 * - serialsForCustody is canonicalized to distinct resolved item.id values
 *   BEFORE the write loop, so one physical asset is never scanned out twice
 *   under different string representations, and an ambiguous candidate set
 *   (matching more than one distinct item) is rejected before any write.
 * - Explicit device/SIM pairs (ctx.pairs) are validated before any write:
 *   a complete pair proceeds; a single-sided entry fails closed with
 *   DEDUCT_PAIR_INCOMPLETE (standalone processing is excluded from E3 —
 *   every single-sided entry requires manual review, since it cannot
 *   currently be distinguished from an accidentally incomplete pair).
 * - OPS-REMED-E3-I.R2: technician-mismatch is now explicitly compared and
 *   rejected (DEDUCT_WRONG_TECHNICIAN) rather than silently resolved by
 *   preferring either side. Explicit pairs are reconciled against
 *   courier_request_items transaction-consistently (via the existing
 *   ICourierInventoryPort.findLinkedRequestItemBySerial(serial, tx) method,
 *   called INSIDE the write transaction) — a disagreement rolls back the
 *   whole request as DEDUCT_INTEGRITY_CONFLICT.
 *
 * Dependencies are injected via static factory — concrete adapters live in /infrastructure/adapters/.
 */

import { randomUUID } from "crypto";
import type { IGeneralInventoryRepository } from "./IGeneralInventoryRepository";
import type { ISerializedInventoryRepository } from "./ISerializedInventoryRepository";
import type { DeductionContext, DeductionResult } from "./inventory.engine.types";
import {
  DeductionError,
  type IInventoryTransactionRunner,
  type InventoryTransactionContext,
  type IDeductionCompletionRecorder,
} from "./inventory.engine.types";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";
import type { ICourierInventoryPort } from "../../domain/repositories/ICourierInventoryPort";
import { consumableRequirements } from "./consumables";

/** Output of InventoryEngine.prepare(): the resolved context and canonical serials. */
export interface PreparedDeduction {
  ctx: DeductionContext;
  canonicalSerials: string[];
}

export class InventoryEngine {
  constructor(
    private readonly generalInventory: IGeneralInventoryRepository,
    private readonly serializedInventory: ISerializedInventoryRepository,
    private readonly inventoryPort: ICourierInventoryPort,
    private readonly txRunner: IInventoryTransactionRunner,
    // OPS-REMED-E4-P2: bounded, explicitly authorized extension (A.6 §5).
    private readonly completionRecorder: IDeductionCompletionRecorder
  ) {}

  /**
   * Execute a full inventory deduction for a completed courier execution.
   * The entire write phase runs inside one transaction; any error
   * (structured DeductionError or an unexpected infra exception)
   * propagates out of this method and rolls back every write made so far.
   */
  async deduct(ctx: DeductionContext): Promise<DeductionResult> {
    const prepared = await this.prepare(ctx);
    return this.txRunner.run((transactionCtx) => this.executePrepared(prepared, transactionCtx));
  }

  /**
   * Read-and-validate phase of deduct(): no writes. Callers that run the
   * write phase inside their own transaction (a courier close that must
   * commit together with its deduction) call this BEFORE opening that
   * transaction, for the pool reason explained below.
   */
  async prepare(ctx: DeductionContext): Promise<PreparedDeduction> {
    // Pure-read technician/serial resolution runs BEFORE the transaction
    // opens (outer pool) — running it inside the transaction on a small
    // connection pool self-deadlocks (the transaction holds one connection
    // while these reads wait for another from the same exhausted pool).
    // These reads only determine WHAT to attempt; every actual accept/
    // reject WRITE decision (ownership re-check in scanOut, stock-level
    // re-check in deductTechnicianInventory, and the reconciliation check
    // below) is re-validated transaction-consistently, inside the
    // transaction, at write time — so staleness here can only ever lead to
    // a safe rejection, never a silent incorrect success.

    // OPS-REMED-E3: validate explicit pairing BEFORE any write. If pairs
    // were supplied, every entry must be a complete pair (both sn and
    // simSerial present) — a single-sided entry is not distinguishable
    // from an accidentally incomplete pair and must fail the whole request
    // closed for manual review.
    if (ctx.pairs && ctx.pairs.length > 0) {
      for (const pair of ctx.pairs) {
        const hasDevice = !!pair.sn?.trim();
        const hasSim = !!pair.simSerial?.trim();
        if (hasDevice !== hasSim) {
          throw new DeductionError(
            "DEDUCT_PAIR_INCOMPLETE",
            ctx.requestId,
            `[InventoryEngine] Single-sided device/SIM entry (sn=${pair.sn ?? "null"}, sim_serial=${pair.simSerial ?? "null"}) cannot be distinguished from an incomplete pair — request rejected, manual review required.`
          );
        }
      }
    }

    // OPS-REMED-E3-I.R2: resolve and validate the technician identity
    // explicitly — compare the approved-request identity against the
    // asset's actual custodian; a mismatch is rejected, never silently
    // resolved by preferring either side.
    const resolvedTech = await this.resolveAndValidateTechnician(ctx);
    ctx.technicianCode = resolvedTech.username;
    (ctx as any).technicianId = resolvedTech.id;

    // OPS-REMED-E3: canonicalize serialsForCustody to distinct resolved
    // item.id values BEFORE any write. A candidate that resolves
    // ambiguously (>1 distinct item) throws DEDUCT_SERIAL_CONFLICT here,
    // before touching the database — never picked via an arbitrary
    // LIMIT 1 at write time. Pure read, outer pool.
    const canonicalSerials = await this.canonicalizeSerials(ctx, undefined);

    return { ctx, canonicalSerials };
  }

  /**
   * Write phase of deduct(), inside the caller's transaction. Every write
   * decision is re-validated here under row locks; any failure throws and
   * the caller's transaction rolls everything back.
   */
  async executePrepared(
    prepared: PreparedDeduction,
    transactionCtx: InventoryTransactionContext
  ): Promise<DeductionResult> {
    const { ctx, canonicalSerials } = prepared;
    const result: DeductionResult = {
      requestId: ctx.requestId,
      generalInventoryDeducted: false,
      custodyItemsDeducted: [],
      errors: [],
    };

    // OPS-REMED-E3-I.R2: reconcile explicit pairs against
    // courier_request_items transaction-consistently — reads happen
    // INSIDE this transaction via the transaction-bound
    // findLinkedRequestItemBySerial(serial, transactionCtx) call, not
    // via a pre-transaction outer-pool read. Any disagreement rolls back
    // the whole request before any write occurs.
    await this.reconcilePairsWithRequestItems(ctx, transactionCtx);

    // v3 custody (items + moving sync via scanOut) is authoritative.
    // Run it first so serials leave active custody and counters drop once.
    await this.deductSerializedCustody(
      { ...ctx, serialsForCustody: canonicalSerials },
      result,
      transactionCtx
    );

    // Legacy general pool only for device SNs that were NOT deducted via custody scan-out
    // (avoids double-decrement of technician_moving_inventory_entries).
    const deducted = new Set(
      result.custodyItemsDeducted.map((s) => s.trim().toLowerCase())
    );
    const remainingDevices = ctx.devices.filter(
      (d) => !deducted.has(d.serialNumber.trim().toLowerCase())
    );
    if (remainingDevices.length > 0) {
      await this.deductGeneralInventory(
        { ...ctx, devices: remainingDevices },
        result,
        transactionCtx
      );
    }

    await this.deductConsumables(ctx, transactionCtx);

    // OPS-REMED-E4-P2: the LAST statement of this transaction — reached
    // only if every prior write above succeeded without throwing. Covers
    // serialized-only, general-only, and mixed deductions uniformly
    // (unlike items.status='DELIVERED' alone, which is silent for
    // general-inventory-only requests — the real gap this closes,
    // A.6 §5). ctx.sourceEventId is optional on DeductionContext for
    // backward compatibility with any existing caller (same pattern
    // already established for ctx.pairs) — the real production caller
    // (InventorySubscriber) always supplies the true causal id; a caller
    // that does not is still recorded (evidence is never silently
    // skipped), using a locally generated id that carries no causal
    // meaning back to any outbox event.
    await this.completionRecorder.recordCompletion(transactionCtx, {
      requestId: ctx.requestId,
      sourceEventId: ctx.sourceEventId ?? randomUUID(),
      generalInventoryDeducted: result.generalInventoryDeducted,
      serializedItemCount: result.custodyItemsDeducted.length,
    });

    return result;
  }

  /**
   * OPS-REMED-E3-I.R2: resolve the APPROVED-REQUEST technician identity
   * (submitted technicianCode) and the asset's ACTUAL custodian (item
   * ownership) SEPARATELY, then compare. A mismatch throws
   * DEDUCT_WRONG_TECHNICIAN — neither side is silently trusted over the
   * other. If only one side resolves, that identity is used (no conflict
   * to detect). If neither resolves, fails closed with the same code.
   */
  private async resolveAndValidateTechnician(
    ctx: DeductionContext
  ): Promise<{ id: string; username: string; fullName: string }> {
    const submittedCode = ctx.technicianCode?.trim();
    let submittedTech: { id: string; username: string; fullName: string } | null = null;
    if (submittedCode) {
      submittedTech = await this.inventoryPort.findUserByCodeOrUsername(submittedCode);
    }

    const custodianTech = await this.resolveCustodianFromSerials(ctx);

    if (submittedTech && custodianTech && submittedTech.id !== custodianTech.id) {
      throw new DeductionError(
        "DEDUCT_WRONG_TECHNICIAN",
        ctx.requestId,
        `[InventoryEngine] Approved-request technician "${submittedTech.username}" does not match the asset's actual custodian "${custodianTech.username}" — mismatch is an integrity conflict, neither identity is silently substituted.`
      );
    }

    const resolved = custodianTech ?? submittedTech;
    if (!resolved) {
      throw new DeductionError(
        "DEDUCT_WRONG_TECHNICIAN",
        ctx.requestId,
        `[InventoryEngine] Technician "${ctx.technicianCode}" could not be resolved from the approved request or from any asset custodian.`
      );
    }
    return resolved;
  }

  /** Resolve the actual custodian from the first serial with a matching owned item. */
  private async resolveCustodianFromSerials(
    ctx: DeductionContext
  ): Promise<{ id: string; username: string; fullName: string } | null> {
    for (const serial of ctx.serialsForCustody) {
      if (!serial?.trim()) continue;
      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(serial);
      if (candidates.length === 0) continue;

      let item: any = null;
      for (const candidate of candidates) {
        const found = await this.inventoryPort.findItemBySerial(candidate);
        if (found) {
          item = found;
          break;
        }
      }

      if (item?.currentOwnerId) {
        const tech = await this.inventoryPort.findUserById(item.currentOwnerId);
        if (tech) return tech;
      }
    }
    return null;
  }

  /**
   * OPS-REMED-E3-I.R2: reconcile explicit device/SIM pairs against the
   * canonical courier_request_items state, transaction-consistently. Uses
   * the existing ICourierInventoryPort.findLinkedRequestItemBySerial
   * method, passing the real transaction context so the read is
   * consistent with the writes made in the same transaction — no
   * pre-transaction outer-pool read is relied upon for this decision.
   *
   * Rule: if courier_request_items has a row linking a submitted serial to
   * a DIFFERENT request than the one being approved, that is a genuine
   * disagreement between the approval data and the database's own
   * request-item ledger — DEDUCT_INTEGRITY_CONFLICT, whole request rolled
   * back, zero partial writes. Absence of a request-item row is not itself
   * an error (courier_request_items is validation/reconciliation-only, not
   * the authoritative source — confirmed OPS-REMED-E-A.4C §4) — only a
   * disagreeing PRESENT row is rejected.
   */
  private async reconcilePairsWithRequestItems(
    ctx: DeductionContext,
    transactionCtx: InventoryTransactionContext
  ): Promise<void> {
    if (!ctx.pairs || ctx.pairs.length === 0) return;

    for (const pair of ctx.pairs) {
      if (pair.sn?.trim()) {
        const link = await this.inventoryPort.findLinkedRequestItemBySerial(
          pair.sn.trim(),
          transactionCtx
        );
        if (link && link.requestId !== ctx.requestId) {
          throw new DeductionError(
            "DEDUCT_INTEGRITY_CONFLICT",
            ctx.requestId,
            `[InventoryEngine] Device serial "${pair.sn}" is linked to request ${link.requestId} in courier_request_items, not the approved request ${ctx.requestId} — disagreement between approval data and request-item ledger.`
          );
        }
      }
      if (pair.simSerial?.trim()) {
        const link = await this.inventoryPort.findLinkedRequestItemBySerial(
          pair.simSerial.trim(),
          transactionCtx
        );
        if (link && link.requestId !== ctx.requestId) {
          throw new DeductionError(
            "DEDUCT_INTEGRITY_CONFLICT",
            ctx.requestId,
            `[InventoryEngine] SIM serial "${pair.simSerial}" is linked to request ${link.requestId} in courier_request_items, not the approved request ${ctx.requestId} — disagreement between approval data and request-item ledger.`
          );
        }
      }
    }
  }

  /**
   * OPS-REMED-E3: resolve every entry in serialsForCustody to its physical
   * item.id, collapse representation-variant duplicates of the SAME item to
   * one entry, and reject (throw DEDUCT_SERIAL_CONFLICT) any candidate that
   * resolves ambiguously to more than one distinct item.
   *
   * OPS-REMED-E3-I.R2 (deadlock-safety correction): the returned order is
   * NOT the caller's submission order. Resolved entries are sorted by their
   * stable physical item.id before being returned, so the FOR UPDATE row
   * locks taken later in deductSerializedCustody are always acquired in the
   * same global order regardless of how the caller listed the serials.
   * Without this, two overlapping multi-asset requests naming the same two
   * assets in reversed order could each hold one lock while waiting on the
   * other — a classic deadlock. Unresolved serials (itemId === null) carry
   * no lock-ordering risk (nothing to lock yet) and are appended after all
   * resolved ones, in their original relative order.
   */
  private async canonicalizeSerials(
    ctx: DeductionContext,
    transactionCtx: InventoryTransactionContext | undefined
  ): Promise<string[]> {
    const seenItemIds = new Set<string>();
    const resolved: { itemId: string; serial: string }[] = [];
    const unresolved: string[] = [];

    for (const serial of ctx.serialsForCustody) {
      let itemId: string | null;
      try {
        itemId = await this.serializedInventory.resolveItemId(serial, transactionCtx);
      } catch (err: any) {
        throw new DeductionError(
          "DEDUCT_SERIAL_CONFLICT",
          ctx.requestId,
          err?.message || `[InventoryEngine] Serial "${serial}" resolved ambiguously.`
        );
      }

      if (itemId === null) {
        // Not found at all — keep the raw serial so the downstream scanOut
        // call produces the normal "not in active custody" outcome, which
        // is classified DEDUCT_INTEGRITY_CONFLICT there.
        unresolved.push(serial);
        continue;
      }

      if (seenItemIds.has(itemId)) {
        // Representation-variant duplicate of an already-included physical
        // asset — skip silently, this is the resolved §2 fix.
        continue;
      }

      seenItemIds.add(itemId);
      resolved.push({ itemId, serial });
    }

    resolved.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

    return [...resolved.map((r) => r.serial), ...unresolved];
  }

  /**
   * Resolve technician: 1) owner of first serial in custody list, 2) username/fullName/code match.
   * Retained for any external/legacy caller relying on the original
   * preference-based resolution; deduct() itself now uses
   * resolveAndValidateTechnician() instead, which does not silently prefer
   * either side.
   */
  async resolveTechnician(
    ctx: DeductionContext
  ): Promise<{ id: string; username: string; fullName: string } | null> {
    const custodian = await this.resolveCustodianFromSerials(ctx);
    if (custodian) return custodian;

    const code = ctx.technicianCode?.trim();
    if (!code) return null;

    const techUser = await this.inventoryPort.findUserByCodeOrUsername(code);
    return techUser ?? null;
  }

  /**
   * Consumables entered on the close (paper rolls, stickers, Neoleap cards).
   * Runs inside the request-wide transaction, so a shortfall rolls back the
   * whole deduction, devices included.
   */
  private async deductConsumables(
    ctx: DeductionContext,
    transactionCtx: InventoryTransactionContext
  ): Promise<void> {
    const items = consumableRequirements(ctx).map((r) => ({ itemTypeId: r.itemTypeId, quantity: r.quantity }));
    if (items.length === 0) return;

    try {
      await this.generalInventory.deductTechnicianConsumables(
        {
          technicianId: (ctx as any).technicianId,
          items,
          actorId: ctx.actorId,
          notes: `خصم مواد استهلاكية — طلب رقم: ${ctx.requestId}`,
        },
        transactionCtx
      );
    } catch (err: any) {
      const code =
        err?.code === "DEDUCT_INSUFFICIENT_STOCK" || err?.code === "DEDUCT_INTEGRITY_CONFLICT"
          ? err.code
          : "DEDUCT_INFRA_TRANSIENT";
      throw new DeductionError(code, ctx.requestId, `[InventoryEngine] Consumables deduction failed: ${err.message}`);
    }
  }

  private async deductGeneralInventory(
    ctx: DeductionContext,
    result: DeductionResult,
    transactionCtx: InventoryTransactionContext
  ): Promise<void> {
    if (ctx.devices.length === 0) return;

    const actor = await this.inventoryPort.findUserById(ctx.actorId);

    try {
      await this.generalInventory.deductTechnicianInventory(
        {
          technicianCode: ctx.technicianCode,
          devices: ctx.devices,
          notes: ctx.notes ?? `خصم تلقائي — طلب رقم: ${ctx.requestId}`,
          actor: {
            id: ctx.actorId,
            username: actor?.username ?? "system",
            role: actor?.role ?? "admin",
            regionId: actor?.regionId ? String(actor.regionId) : null,
          },
        },
        transactionCtx
      );

      result.generalInventoryDeducted = true;
    } catch (err: any) {
      // A general-inventory deduction failure must roll back the whole
      // request (per the atomic-transaction invariant) — throw rather than
      // swallow into result.errors.
      const code = err?.code === "DEDUCT_INSUFFICIENT_STOCK" ? "DEDUCT_INSUFFICIENT_STOCK" : "DEDUCT_INFRA_TRANSIENT";
      throw new DeductionError(code, ctx.requestId, `[InventoryEngine] General deduction failed: ${err.message}`);
    }
  }

  private async deductSerializedCustody(
    ctx: DeductionContext,
    result: DeductionResult,
    transactionCtx: InventoryTransactionContext
  ): Promise<void> {
    if (ctx.serialsForCustody.length === 0) return;

    const techUserId = (ctx as any).technicianId as string | undefined;

    if (!techUserId) {
      throw new DeductionError(
        "DEDUCT_WRONG_TECHNICIAN",
        ctx.requestId,
        `[InventoryEngine] Technician "${ctx.technicianCode}" not found for custody ScanOut.`
      );
    }

    for (const serial of ctx.serialsForCustody) {
      let deducted: boolean;
      try {
        deducted = await this.serializedInventory.scanOut(
          techUserId,
          serial,
          ctx.customerName,
          ctx.referenceNumber,
          transactionCtx
        );
      } catch (err: any) {
        throw new DeductionError(
          "DEDUCT_INFRA_TRANSIENT",
          ctx.requestId,
          `[InventoryEngine] ScanOut failed for "${serial}": ${err.message}`
        );
      }

      if (deducted) {
        result.custodyItemsDeducted.push(serial);
      } else {
        // An item not found in active custody under this technician —
        // permanent business rejection, rolls back the whole request.
        // Same-request provenance is not provable (confirmed
        // OPS-REMED-E-A.4 §3), so this is never treated as a safe no-op.
        throw new DeductionError(
          "DEDUCT_INTEGRITY_CONFLICT",
          ctx.requestId,
          `[InventoryEngine] ScanOut skipped for "${serial}" — not found in technician active custody, and same-request provenance is not provable.`
        );
      }
    }
  }
}
