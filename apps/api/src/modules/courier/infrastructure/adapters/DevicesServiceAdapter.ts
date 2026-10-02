/**
 * DevicesServiceAdapter
 *
 * Implements IGeneralInventoryRepository by wrapping devicesContainer.devicesService.
 * This is the only file that knows about devicesContainer in the Inventory layer.
 */

import { devicesContainer } from "@server/composition/devices.container";
import type {
  IGeneralInventoryRepository,
  DeductInventoryCommand,
  DeductConsumablesCommand,
} from "../../application/inventory/IGeneralInventoryRepository";
import type { InventoryTransactionContext } from "../../application/inventory/inventory.engine.types";
import { unwrapInventoryTransactionContext } from "../database/DrizzleInventoryTransactionRunner";

export class DevicesServiceAdapter implements IGeneralInventoryRepository {
  async deductTechnicianInventory(
    command: DeductInventoryCommand,
    ctx?: InventoryTransactionContext
  ): Promise<void> {
    await devicesContainer.devicesService.deductTechnicianInventory(
      {
        technicianCode: command.technicianCode,
        devices: command.devices,
        notes: command.notes,
        actor: command.actor,
      },
      ctx ? unwrapInventoryTransactionContext(ctx) : undefined
    );
  }

  async deductTechnicianConsumables(
    command: DeductConsumablesCommand,
    ctx?: InventoryTransactionContext
  ): Promise<void> {
    await devicesContainer.devicesService.deductTechnicianConsumables(
      command,
      ctx ? unwrapInventoryTransactionContext(ctx) : undefined
    );
  }
}
