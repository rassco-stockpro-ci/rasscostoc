export { registerCourierRoutes } from "../presentation/routes/courier.routes";
export { bootstrapCourierModule, createInventoryEngine, updateCustodyClosureStatus, hasInventoryDeductionCompletion } from "../composition/courier.container";
export { resolveConsumableQuantities } from "../application/inventory/consumables";
export type { CourierController } from "../presentation/controllers/courier.controller";
export type { CourierService } from "../application/courier.service";
export type { InventoryEngine } from "../application/inventory/inventory.engine";
