/**
 * The single consumable quantity rule (resolveConsumableQuantities): the guard
 * and the deduction must compute the same quantities for the same close.
 */
import { describe, expect, it } from "vitest";
import { ConsumableQuantityError, resolveConsumableQuantities, type ConsumableSource } from "./consumables";

const NONE = { paperRollQty: 0, stickersQty: 0, nulipCardsQty: 0 };

describe("resolveConsumableQuantities", () => {
  it("zero stays zero", () => {
    expect(resolveConsumableQuantities({ paperRollQty: 0, stickersQty: 0, nulipCardsQty: 0 }, null)).toEqual(NONE);
    expect(resolveConsumableQuantities({ paperRollQty: "0", paperRoll: "Yes" }, null)).toEqual(NONE);
  });

  it("positive quantities, as numbers or digit strings", () => {
    expect(resolveConsumableQuantities({ paperRollQty: 2, stickersQty: "3", nulipCardsQty: " 1 " }, null)).toEqual({
      paperRollQty: 2,
      stickersQty: 3,
      nulipCardsQty: 1,
    });
  });

  it("not submitted on a new row: the column default 0 (even with paperRoll 'Yes')", () => {
    expect(resolveConsumableQuantities({ paperRoll: "Yes" }, null)).toEqual(NONE);
  });

  it("not submitted on an update: the stored value", () => {
    expect(resolveConsumableQuantities({}, { paperRollQty: 54, stickersQty: 2, nulipCardsQty: 0 })).toEqual({
      paperRollQty: 54,
      stickersQty: 2,
      nulipCardsQty: 0,
    });
  });

  it("empty (null or ''): paper rolls follow the legacy Yes/No flag, other items are 0", () => {
    expect(resolveConsumableQuantities({ paperRollQty: null, paperRoll: "Yes" }, null).paperRollQty).toBe(1);
    expect(resolveConsumableQuantities({ paperRollQty: "", paperRoll: "Yes" }, null).paperRollQty).toBe(1);
    expect(resolveConsumableQuantities({ paperRollQty: null, paperRoll: "No" }, null).paperRollQty).toBe(0);
    expect(resolveConsumableQuantities({ stickersQty: "", nulipCardsQty: null }, null)).toEqual(NONE);
  });

  it("legacy row (stored NULL quantity, paperRoll 'Yes'): one roll — on update and on the saved row alike", () => {
    const legacy: ConsumableSource = { paperRollQty: null, stickersQty: null, nulipCardsQty: null, paperRoll: "Yes" };
    expect(resolveConsumableQuantities({}, legacy)).toEqual({ paperRollQty: 1, stickersQty: 0, nulipCardsQty: 0 });
    expect(resolveConsumableQuantities(legacy, null)).toEqual({ paperRollQty: 1, stickersQty: 0, nulipCardsQty: 0 });
  });

  it("invalid quantities are rejected with 422, never silently treated as 0", () => {
    for (const bad of [-1, "-1", 1.5, "1.5", "abc", Number.NaN, Infinity]) {
      let err: unknown;
      try {
        resolveConsumableQuantities({ stickersQty: bad as any }, null);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConsumableQuantityError);
      expect((err as ConsumableQuantityError).statusCode).toBe(422);
      expect((err as ConsumableQuantityError).code).toBe("CONSUMABLE_QUANTITY_INVALID");
    }
  });

  it("guard view (submitted over stored) == deduction view (the saved row) for every combination", () => {
    const submittedValues: ConsumableSource["paperRollQty"][] = [undefined, null, "", 0, 3, "4"];
    const storedRows: (ConsumableSource | null)[] = [
      null,
      { paperRollQty: null, paperRoll: "Yes" },
      { paperRollQty: 7, paperRoll: "Yes" },
      { paperRollQty: 0, paperRoll: "No" },
    ];
    for (const stored of storedRows) {
      for (const submitted of submittedValues) {
        for (const flag of [undefined, "Yes", "No"]) {
          const input: ConsumableSource = { paperRollQty: submitted, paperRoll: flag };
          // What the save writes: submitted fields over the stored row; a new row gets the column default 0.
          const saved: ConsumableSource = {
            paperRollQty: submitted !== undefined ? submitted : stored ? stored.paperRollQty : 0,
            paperRoll: flag !== undefined ? flag : stored?.paperRoll,
          };
          const guard = resolveConsumableQuantities(input, stored);
          const deduction = resolveConsumableQuantities(saved, null);
          expect({ stored, submitted, flag, q: guard.paperRollQty }).toEqual({ stored, submitted, flag, q: deduction.paperRollQty });
        }
      }
    }
  });
});
