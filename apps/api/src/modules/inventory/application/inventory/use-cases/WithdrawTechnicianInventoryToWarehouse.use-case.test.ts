import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from "@core/errors/AppError";
import {
  WithdrawTechnicianInventoryToWarehouseUseCase,
  WithdrawToWarehouseUseCaseError,
  type IWithdrawTechnicianInventoryToWarehouseRepository,
  type WithdrawTechnicianInventoryToWarehouseInput,
} from './WithdrawTechnicianInventoryToWarehouse.use-case';

type MockRepo = {
  [K in keyof IWithdrawTechnicianInventoryToWarehouseRepository]: ReturnType<typeof vi.fn>;
};

function createMockRepository(): MockRepo {
  return {
    getUser: vi.fn(),
    getWarehouse: vi.fn(),
    getTechnicianMovingInventoryEntries: vi.fn(),
    getWarehouseInventoryEntries: vi.fn(),
    getTechnicianInventory: vi.fn(),
    getWarehouseInventory: vi.fn(),
    upsertTechnicianMovingInventoryEntry: vi.fn(),
    upsertWarehouseInventoryEntry: vi.fn(),
    updateTechnicianInventory: vi.fn(),
    updateWarehouseInventory: vi.fn(),
    logSystemActivity: vi.fn(),
    assertItemsQuantityTrackable: vi.fn().mockResolvedValue(undefined),
    isIdempotentWithdrawReplay: vi.fn().mockResolvedValue(false),
  };
}

function buildValidInput(overrides: Partial<WithdrawTechnicianInventoryToWarehouseInput> = {}): WithdrawTechnicianInventoryToWarehouseInput {
  return {
    actor: {
      id: 'admin-1',
      username: 'admin',
      role: 'admin',
      regionId: 'region-a',
    },
    technicianId: 'tech-1',
    warehouseId: 'warehouse-1',
    notes: 'test notes',
    items: [
      { itemTypeId: 'n950', packagingType: 'box', quantity: 2 },
      { itemTypeId: 'n950', packagingType: 'box', quantity: 1 },
      { itemTypeId: 'n950', packagingType: 'unit', quantity: 2 },
    ],
    idempotencyKey: 'withdraw-test-key-0001',
    ...overrides,
  };
}

describe('WithdrawTechnicianInventoryToWarehouseUseCase', () => {
  it('withdraws successfully, aggregates duplicated items, updates dynamic+legacy stock and logs activity', async () => {
    const repository = createMockRepository();
    const useCase = new WithdrawTechnicianInventoryToWarehouseUseCase(repository);

    repository.getUser.mockResolvedValue({
      id: 'tech-1',
      role: 'technician',
      fullName: 'Tech One',
      regionId: 'region-a',
    });
    repository.getWarehouse.mockResolvedValue({
      id: 'warehouse-1',
      name: 'WH-1',
      regionId: 'region-a',
    });
    repository.getTechnicianMovingInventoryEntries.mockResolvedValue([
      { itemTypeId: 'n950', boxes: 5, units: 4 },
    ]);
    repository.getWarehouseInventoryEntries.mockResolvedValue([
      { itemTypeId: 'n950', boxes: 1, units: 2 },
    ]);
    repository.getTechnicianInventory.mockResolvedValue({
      n950Boxes: 5,
      n950Units: 4,
    });
    repository.getWarehouseInventory.mockResolvedValue({
      n950Boxes: 1,
      n950Units: 2,
    });

    const result = await useCase.execute(buildValidInput());

    expect(result).toEqual({
      success: true,
      message: 'تم سحب المخزون إلى المستودع بنجاح',
      itemsCount: 2,
      totalQuantity: 5,
    });

    expect(repository.upsertTechnicianMovingInventoryEntry).toHaveBeenCalledWith('tech-1', 'n950', 2, 2);
    expect(repository.upsertWarehouseInventoryEntry).toHaveBeenCalledWith('warehouse-1', 'n950', 4, 4);

    expect(repository.updateTechnicianInventory).toHaveBeenCalledWith('tech-1', {
      n950Boxes: 2,
      n950Units: 2,
    });
    expect(repository.updateWarehouseInventory).toHaveBeenCalledWith('warehouse-1', {
      n950Boxes: 4,
      n950Units: 4,
    });

    expect(repository.logSystemActivity).toHaveBeenCalledTimes(1);
    expect(repository.logSystemActivity.mock.calls[0][0].description).toContain('تم سحب 5 من مخزون المندوب Tech One إلى المستودع WH-1');
  });

  it('throws NotFoundError when technician does not exist', async () => {
    const repository = createMockRepository();
    const useCase = new WithdrawTechnicianInventoryToWarehouseUseCase(repository);

    repository.getUser.mockResolvedValue(undefined);

    await expect(useCase.execute(buildValidInput())).rejects.toThrowError(NotFoundError);
  });

  it('throws NotFoundError when warehouse does not exist', async () => {
    const repository = createMockRepository();
    const useCase = new WithdrawTechnicianInventoryToWarehouseUseCase(repository);

    repository.getUser.mockResolvedValue({
      id: 'tech-1',
      role: 'technician',
      fullName: 'Tech One',
      regionId: 'region-a',
    });
    repository.getWarehouse.mockResolvedValue(undefined);

    await expect(useCase.execute(buildValidInput())).rejects.toThrowError(NotFoundError);
  });

  it('throws 403 when supervisor withdraws to warehouse outside supervisor region', async () => {
    const repository = createMockRepository();
    const useCase = new WithdrawTechnicianInventoryToWarehouseUseCase(repository);

    repository.getUser.mockResolvedValue({
      id: 'tech-1',
      role: 'technician',
      fullName: 'Tech One',
      regionId: 'region-a',
    });
    repository.getWarehouse.mockResolvedValue({
      id: 'warehouse-1',
      name: 'WH-1',
      regionId: 'region-b',
    });

    await expect(
      useCase.execute(
        buildValidInput({
          actor: {
            id: 'sup-1',
            username: 'sup',
            role: 'supervisor',
            regionId: 'region-a',
          },
        })
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'لا يمكنك السحب إلى مستودع خارج منطقتك',
    } satisfies Partial<WithdrawToWarehouseUseCaseError>);
  });

  it('throws 400 on insufficient technician moving stock and performs no writes', async () => {
    const repository = createMockRepository();
    const useCase = new WithdrawTechnicianInventoryToWarehouseUseCase(repository);

    repository.getUser.mockResolvedValue({
      id: 'tech-1',
      role: 'technician',
      fullName: 'Tech One',
      regionId: 'region-a',
    });
    repository.getWarehouse.mockResolvedValue({
      id: 'warehouse-1',
      name: 'WH-1',
      regionId: 'region-a',
    });
    repository.getTechnicianMovingInventoryEntries.mockResolvedValue([
      { itemTypeId: 'n950', boxes: 1, units: 0 },
    ]);
    repository.getWarehouseInventoryEntries.mockResolvedValue([]);
    repository.getTechnicianInventory.mockResolvedValue({ n950Boxes: 1, n950Units: 0 });
    repository.getWarehouseInventory.mockResolvedValue({ n950Boxes: 0, n950Units: 0 });

    await expect(
      useCase.execute(
        buildValidInput({
          items: [{ itemTypeId: 'n950', packagingType: 'box', quantity: 2 }],
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'الكمية غير كافية للصنف n950. المتاح: 1 كرتون',
    } satisfies Partial<WithdrawToWarehouseUseCaseError>);

    expect(repository.upsertTechnicianMovingInventoryEntry).not.toHaveBeenCalled();
    expect(repository.upsertWarehouseInventoryEntry).not.toHaveBeenCalled();
    expect(repository.updateTechnicianInventory).not.toHaveBeenCalled();
    expect(repository.updateWarehouseInventory).not.toHaveBeenCalled();
    expect(repository.logSystemActivity).not.toHaveBeenCalled();
  });
});

