/**
 * Unit tests for SerializedItemsService.searchItems()'s own guard logic
 * (empty query / empty scope short-circuits) and that it normalizes the
 * raw query the same way write-time normalization does before matching.
 *
 * This does NOT prove the ILIKE query actually matches a real stored row in
 * Postgres — no DATABASE_URL is available in this environment (see the
 * routes test file in presentation/routes/ for the full note). The DB call
 * itself is mocked here; only the service's own pre-DB logic is exercised.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const normalizeRawBarcodeMock = vi.fn((raw: string) => raw.trim().toUpperCase());

vi.mock("@core/serial/serial-recognition.service", () => ({
  SerialRecognitionService: {
    normalizeRawBarcode: (raw: string) => normalizeRawBarcodeMock(raw),
  },
}));

const selectMock = vi.fn();
vi.mock("@core/config/db", () => ({
  db: {
    select: (...args: any[]) => selectMock(...args),
  },
}));

import { SerializedItemsService } from "./serialized-items.service";

describe("SerializedItemsService.searchItems", () => {
  const service = new SerializedItemsService();

  beforeEach(() => {
    normalizeRawBarcodeMock.mockClear();
    selectMock.mockClear();
  });

  it("empty/whitespace query returns [] without touching the database", async () => {
    expect(await service.searchItems("   ")).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("a real scope restriction that resolves to zero technicians returns [] without querying (not treated as unrestricted)", async () => {
    expect(await service.searchItems("SN123", [])).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("normalizes the raw query the same way write-time normalization runs before matching", async () => {
    const chain: any = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve([])),
    };
    selectMock.mockReturnValue(chain);

    await service.searchItems("  sn: abc-123  ");

    expect(normalizeRawBarcodeMock).toHaveBeenCalledWith("  sn: abc-123  ");
    expect(selectMock).toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(50);
  });
});
