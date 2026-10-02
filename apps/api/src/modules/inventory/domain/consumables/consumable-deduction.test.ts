import { describe, expect, it } from "vitest";
import { planConsumableDeduction } from "./consumable-deduction";

describe("planConsumableDeduction — moving rows first, loose units before opening boxes", () => {
  it("takes loose units only when they suffice", () => {
    const plan = planConsumableDeduction(3, 50, [{ boxes: 2, units: 5 }]);
    expect(plan).toEqual({ ok: true, after: [{ boxes: 2, units: 2 }], taken: [3] });
  });

  it("opens exactly the boxes needed and returns the remainder to loose units", () => {
    const plan = planConsumableDeduction(7, 50, [{ boxes: 2, units: 5 }]);
    expect(plan).toEqual({ ok: true, after: [{ boxes: 1, units: 48 }], taken: [7] });
  });

  it("opens several boxes for a large quantity", () => {
    // 10 loose + 3 boxes (150) = 160; taking 120 opens all 3 boxes and leaves 40 loose.
    const plan = planConsumableDeduction(120, 50, [{ boxes: 3, units: 10 }]);
    expect(plan).toEqual({ ok: true, after: [{ boxes: 0, units: 40 }], taken: [120] });
  });

  it("drains the moving bucket before touching the fixed bucket", () => {
    const plan = planConsumableDeduction(60, 50, [{ boxes: 1, units: 5 }, { boxes: 2, units: 0 }]);
    expect(plan).toEqual({
      ok: true,
      after: [{ boxes: 0, units: 0 }, { boxes: 1, units: 45 }],
      taken: [55, 5],
    });
  });

  it("leaves the fixed bucket untouched when moving covers the quantity", () => {
    const plan = planConsumableDeduction(4, 10, [{ boxes: 0, units: 4 }, { boxes: 5, units: 5 }]);
    expect(plan).toEqual({ ok: true, after: [{ boxes: 0, units: 0 }, { boxes: 5, units: 5 }], taken: [4, 0] });
  });

  it("refuses when moving + fixed together cannot cover the quantity, reporting availability", () => {
    expect(planConsumableDeduction(200, 50, [{ boxes: 1, units: 5 }, { boxes: 2, units: 3 }])).toEqual({
      ok: false,
      available: 158,
    });
  });

  it("refuses with no stock rows at all", () => {
    expect(planConsumableDeduction(1, 100, [])).toEqual({ ok: false, available: 0 });
  });

  it("deducts an exact full balance down to zero", () => {
    const plan = planConsumableDeduction(25, 10, [{ boxes: 2, units: 5 }]);
    expect(plan).toEqual({ ok: true, after: [{ boxes: 0, units: 0 }], taken: [25] });
  });

  it("treats negative stored values as zero availability", () => {
    expect(planConsumableDeduction(1, 10, [{ boxes: -1, units: -3 }])).toEqual({ ok: false, available: 0 });
  });

  it("rejects non-positive or fractional quantities and invalid unitsPerBox", () => {
    expect(() => planConsumableDeduction(0, 10, [{ boxes: 1, units: 0 }])).toThrow();
    expect(() => planConsumableDeduction(1.5, 10, [{ boxes: 1, units: 0 }])).toThrow();
    expect(() => planConsumableDeduction(1, 0, [{ boxes: 1, units: 0 }])).toThrow();
  });
});
