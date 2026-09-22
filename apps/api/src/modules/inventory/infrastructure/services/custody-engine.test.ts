import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CustodyEngine } from './custody-engine';
import { SerialRecognitionService } from '@core/serial/serial-recognition.service';

vi.mock('@core/serial/serial-recognition.service', () => ({
  SerialRecognitionService: {
    findItemBySerial: vi.fn(),
    normalizeForStorage: vi.fn(),
    buildStoredSerialCandidates: vi.fn(),
    recognize: vi.fn(),
    normalizeRawBarcode: vi.fn((s: string) => String(s || '').trim().toUpperCase()),
  },
}));

describe('CustodyEngine Unit Tests', () => {
  let mockTx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      for: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: 'item-1' }]),
    };
  });

  describe('lookupItem', () => {
    it('returns item when found via SerialRecognitionService', async () => {
      const mockItem = { id: 'item-1', serialNumber: 'SN123' };
      vi.mocked(SerialRecognitionService.findItemBySerial).mockResolvedValue(mockItem as any);

      const result = await CustodyEngine.lookupItem('SN123', mockTx);
      expect(result).toEqual(mockItem);
      expect(SerialRecognitionService.findItemBySerial).toHaveBeenCalledWith('SN123', mockTx);
    });

    it('returns null when not found', async () => {
      vi.mocked(SerialRecognitionService.findItemBySerial).mockResolvedValue(null);

      const result = await CustodyEngine.lookupItem('SN123', mockTx);
      expect(result).toBeNull();
    });
  });

  describe('scanItem', () => {
    it('creates new item and registers custody when not exists', async () => {
      vi.mocked(SerialRecognitionService.normalizeForStorage).mockResolvedValue({
        normalizedSerial: 'SN123',
        itemTypeId: 'type-1',
        carrierName: null,
        rawBarcode: 'SN123',
        category: 'devices',
        nameAr: 'جهاز',
      });
      vi.mocked(SerialRecognitionService.findItemBySerial).mockResolvedValue(null);

      const result = await CustodyEngine.scanItem('SN123', 'type-1', 'tech-1', mockTx);
      expect(result).toEqual({ id: 'item-1', action: 'inserted' });
      expect(mockTx.insert).toHaveBeenCalled();
    });

    it('throws when item already active', async () => {
      vi.mocked(SerialRecognitionService.normalizeForStorage).mockResolvedValue({
        normalizedSerial: 'SN123',
        itemTypeId: 'type-1',
        carrierName: null,
        rawBarcode: 'SN123',
        category: 'devices',
        nameAr: 'جهاز',
      });
      vi.mocked(SerialRecognitionService.findItemBySerial).mockResolvedValue({
        id: 'item-1',
        serialNumber: 'SN123',
        currentOwnerId: null,
        status: 'WAREHOUSE',
      } as any);

      await expect(CustodyEngine.scanItem('SN123', 'type-1', 'tech-1', mockTx)).rejects.toThrow(
        'المنتج موجود مسبقاً وحالته نشط'
      );
    });

    it('throws when item already delivered', async () => {
      vi.mocked(SerialRecognitionService.normalizeForStorage).mockResolvedValue({
        normalizedSerial: 'SN123',
        itemTypeId: 'type-1',
        carrierName: null,
        rawBarcode: 'SN123',
        category: 'devices',
        nameAr: 'جهاز',
      });
      vi.mocked(SerialRecognitionService.findItemBySerial).mockResolvedValue({
        id: 'item-1',
        serialNumber: 'SN123',
        currentOwnerId: null,
        status: 'DELIVERED',
      } as any);

      await expect(CustodyEngine.scanItem('SN123', 'type-1', 'tech-1', mockTx)).rejects.toThrow(
        'المنتج موجود وحالته مغلق'
      );
    });
  });

  describe('deliverItem', () => {
    it('delivers when ownership matches', async () => {
      const existingItem = {
        id: 'item-1',
        serialNumber: 'SN123',
        currentOwnerId: 'tech-1',
        status: 'RECEIVED_BY_TECHNICIAN',
        itemTypeId: 'type-1',
      };
      mockTx.limit.mockResolvedValue([existingItem]);

      await CustodyEngine.deliverItem('item-1', 'ORD-1', 'tech-1', 'admin-1', mockTx);
      expect(mockTx.update).toHaveBeenCalled();
      expect(mockTx.insert).toHaveBeenCalled();
    });

    it('throws when ownership mismatches', async () => {
      const existingItem = {
        id: 'item-1',
        serialNumber: 'SN123',
        currentOwnerId: 'tech-2',
        status: 'RECEIVED_BY_TECHNICIAN',
        itemTypeId: 'type-1',
      };
      mockTx.limit.mockResolvedValue([existingItem]);

      await expect(
        CustodyEngine.deliverItem('item-1', 'ORD-1', 'tech-1', 'admin-1', mockTx)
      ).rejects.toThrow('الجهاز المطلوب تسليمه ليس في عهدة هذا الفني حالياً');
    });
  });
  describe('returnItem', () => {
    it('throws when a stale caller no longer owns the locked item', async () => {
      const existingItem = {
        id: 'item-1',
        serialNumber: 'SN123',
        currentOwnerId: 'tech-2',
        status: 'RECEIVED_BY_TECHNICIAN',
        itemTypeId: 'type-1',
      };
      mockTx.limit.mockResolvedValue([existingItem]);

      await expect(
        CustodyEngine.returnItem('item-1', 'WH-1', 'tech-1', 'admin-1', mockTx)
      ).rejects.toThrow('الجهاز المطلوب إرجاعه ليس في عهدة هذا الفني حالياً');
      expect(mockTx.update).not.toHaveBeenCalled();
      expect(mockTx.insert).not.toHaveBeenCalled();
    });
  });

});
