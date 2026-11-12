import { describe, expect, it, vi } from "vitest";

// item-types.service.ts imports `db` eagerly at module load time, which throws
// if DATABASE_URL isn't set — irrelevant here since every test below injects
// a fake ItemTypesService and never touches the real db.
vi.mock("@core/config/db", () => ({ db: {}, pool: {} }));

import { resolveSimItemTypeCandidates } from "./sim-item-type-resolver";

/**
 * These tests drive `resolveSimItemTypeCandidates` through its REAL code path
 * against fixture catalog rows (via dependency injection, not a mocked DB) —
 * proving the resolver itself has zero special-casing for any specific
 * carrier id/name. A brand-new catalog type an admin adds tomorrow — with its
 * own serial_regex — must resolve correctly with ZERO code changes, because
 * the function only ever reads `category`/`serialRegex`/`nameEn` off
 * whatever rows the catalog service returns.
 */
function fakeItemTypesService(rows: any[]) {
  // Fixture rows default to serialized (requiresSerial=true) unless a test says otherwise.
  return {
    getActiveItemTypes: async () => rows.map((r) => ({ requiresSerial: true, ...r })),
  } as any;
}

describe("resolveSimItemTypeCandidates — catalog-driven, zero hardcoded carrier logic", () => {
  it("grep-equivalent proof: a never-before-seen catalog type (not stc/zain/mobily/lebara) resolves correctly with no code change", async () => {
    const catalog = [
      {
        id: "virginSim",
        nameEn: "Virgin Mobile SIM",
        nameAr: "شريحة فيرجن",
        category: "sim",
        serialRegex: "^VIRGIN[0-9]{10}$",
      },
    ];

    const result = await resolveSimItemTypeCandidates(
      "VIRGIN1234567890",
      undefined,
      fakeItemTypesService(catalog)
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("virginSim");
  });

  it("two catalog types sharing an identical regex (mirrors production: mobilySim/stcSim) — genuinely ambiguous, returns both, picks neither", async () => {
    const catalog = [
      { id: "mobilySim", nameEn: "Mobily SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
      { id: "stcSim", nameEn: "STC SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
    ];

    const result = await resolveSimItemTypeCandidates(
      "899660000000000001",
      undefined,
      fakeItemTypesService(catalog)
    );

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["mobilySim", "stcSim"]);
  });

  it("regex match alone is never proof of identity when the pattern is shared: hint text narrows an ambiguous set down to one, but ONLY among already regex-confirmed candidates", async () => {
    const catalog = [
      { id: "mobilySim", nameEn: "Mobily SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
      { id: "stcSim", nameEn: "STC SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
    ];

    const result = await resolveSimItemTypeCandidates(
      "899660000000000001",
      "STC 1x",
      fakeItemTypesService(catalog)
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("stcSim");
  });

  it("an explicit choice that contradicts every regex match yields zero candidates (never swapped for a different matching type)", async () => {
    const catalog = [
      { id: "mobilySim", nameEn: "Mobily SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
      { id: "stcSim", nameEn: "STC SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
    ];

    const result = await resolveSimItemTypeCandidates(
      "899660000000000001",
      "Virgin Mobile 2x", // names a carrier that isn't a regex candidate here
      fakeItemTypesService(catalog)
    );

    expect(result).toHaveLength(0);
  });

  it("a single regex match is NOT accepted when the explicit choice names a different carrier", async () => {
    const catalog = [
      { id: "stcSim", nameEn: "STC SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
      { id: "zainSim", nameEn: "Zain SIM", category: "sim", serialRegex: "^ZN[0-9]{10}$" },
    ];

    const result = await resolveSimItemTypeCandidates(
      "899660000000000001",
      "Zain",
      fakeItemTypesService(catalog)
    );

    expect(result).toHaveLength(0);
  });

  it("a type with no serialRegex configured can never be regex-matched, by design — excluded from candidates entirely", async () => {
    const catalog = [
      { id: "zainSimNew", nameEn: "Zain SIM New", category: "sim", serialRegex: null },
      { id: "stcSim", nameEn: "STC SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
    ];

    const result = await resolveSimItemTypeCandidates(
      "899660000000000001",
      undefined,
      fakeItemTypesService(catalog)
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("stcSim");
  });

  it("a requiresSerial=false (quantity-tracked) type is never a candidate for a serialized item, even if its regex matches", async () => {
    const catalog = [
      { id: "qtySim", nameEn: "Qty SIM", category: "sim", requiresSerial: false, serialRegex: "^89966[0-9]{13,14}$" },
      { id: "stcSim", nameEn: "STC SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
    ];

    const result = await resolveSimItemTypeCandidates(
      "899660000000000001",
      undefined,
      fakeItemTypesService(catalog)
    );

    expect(result.map((r) => r.id)).toEqual(["stcSim"]);
  });

  it("non-sim category rows are never candidates, regardless of regex", async () => {
    const catalog = [
      { id: "n950", nameEn: "N950", category: "devices", serialRegex: "^(NCC|NCD)[0-9]{9}$" },
      { id: "stcSim", nameEn: "STC SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
    ];

    const result = await resolveSimItemTypeCandidates(
      "899660000000000001",
      undefined,
      fakeItemTypesService(catalog)
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("stcSim");
  });

  it("a malformed regex stored in the catalog is skipped, not thrown", async () => {
    const catalog = [
      { id: "broken", nameEn: "Broken Type", category: "sim", serialRegex: "(unclosed" },
      { id: "stcSim", nameEn: "STC SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
    ];

    const result = await resolveSimItemTypeCandidates(
      "899660000000000001",
      undefined,
      fakeItemTypesService(catalog)
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("stcSim");
  });

  it("no catalog row's regex matches — zero candidates, not a thrown error at this layer (the caller decides how to fail)", async () => {
    const catalog = [
      { id: "stcSim", nameEn: "STC SIM", category: "sim", serialRegex: "^89966[0-9]{13,14}$" },
    ];

    const result = await resolveSimItemTypeCandidates(
      "NOT-A-MATCHING-SERIAL",
      undefined,
      fakeItemTypesService(catalog)
    );

    expect(result).toHaveLength(0);
  });
});
