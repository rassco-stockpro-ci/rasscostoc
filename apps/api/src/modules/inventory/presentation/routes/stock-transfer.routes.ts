import type { Express } from "express";
import { requireAuth } from "@core/middlewares/auth.middleware";
import { stockTransferContainer } from "@server/composition/stock-transfer.container";

/**
 * Stock Transfer Routes - نقل المخزون و الحركات (< 100 lines)
 * مجال المسؤولية: نقل المخزون بين أنواع المخزون المختلفة وتتبع الحركات
 */
export function registerStockTransferRoutes(app: Express): void {
  // NOTE: a duplicate, unguarded POST /api/stock-transfer used to be
  // registered here (no ownership check, no idempotency key, no
  // requires_serial guard). Proven dead code by an HTTP-level test
  // (stock-transfer-duplicate-route.routes.test.ts): Express dispatches to
  // the FIRST matching handler, and the guarded one in
  // technicians-inventory.routes.ts registers before this file in
  // index.ts — same pattern as the duplicate route already removed as
  // part of the IDOR fix. Removed rather than left to silently diverge
  // from the guarded version (it no longer even typechecks against the
  // current StockTransferInput).

  // عرض حركات المخزون
  app.get("/api/stock-movements", requireAuth, async (req, res) => {
    try {
      const movements = await stockTransferContainer.stockTransferUseCase.getMovements();
      res.json(movements);
    } catch (error) {
      console.error("Error fetching stock movements:", error);
      res.status(500).json({ message: "Failed to fetch stock movements" });
    }
  });
}