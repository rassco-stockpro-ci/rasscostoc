import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SimTypeField } from "./courier-sim-type-field";
import type { SimRowLike } from "@/lib/sim-type";

const found = (carrierName: string | null): SimRowLike["lookup"] => ({
  found: true,
  item: { id: "x" },
  itemType: { carrierName },
});

describe("SimTypeField — read-only, derived from the lookup", () => {
  it("shows the type the lookup returned (the case from production: STC, with an empty sim-types table)", () => {
    render(<SimTypeField rows={[{ value: "89966011003527898", lookup: found("STC") }]} />);
    expect(screen.getByTestId("sim-type-value").textContent).toBe("STC");
    expect(screen.queryByText("اختر النوع")).toBeNull();
  });

  it("is not a selector: the user cannot pick another type", () => {
    render(<SimTypeField rows={[{ value: "89966011003527898", lookup: found("STC") }]} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.querySelector("select")).toBeNull();
    expect(screen.getByTestId("sim-type-value").getAttribute("aria-readonly")).toBe("true");
  });

  it("clears immediately when the ICCID changes (the lookup is reset)", () => {
    const { rerender } = render(<SimTypeField rows={[{ value: "89966011003527898", lookup: found("STC") }]} />);
    expect(screen.getByTestId("sim-type-value").textContent).toBe("STC");
    rerender(<SimTypeField rows={[{ value: "89966011003527899", lookup: null }]} />);
    expect(screen.getByTestId("sim-type-value").textContent).toBe("—");
    rerender(<SimTypeField rows={[{ value: "89966011003527899", lookup: found("Zain") }]} />);
    expect(screen.getByTestId("sim-type-value").textContent).toBe("Zain");
  });

  it("a SIM whose type is unknown shows a clear message instead of inventing a type", () => {
    render(<SimTypeField rows={[{ value: "89966011003527898", lookup: found(null) }]} />);
    expect(screen.getByTestId("sim-type-value").textContent).toBe("غير متاح");
    expect(screen.getByTestId("sim-type-unavailable").textContent).toContain("SIM_TYPE_UNAVAILABLE");
  });

  it("two SIMs: both types are shown, not one shared type", () => {
    render(
      <SimTypeField
        rows={[
          { value: "A", lookup: found("STC") },
          { value: "B", lookup: found("Zain") },
        ]}
      />
    );
    expect(screen.getByTestId("sim-type-value").textContent).toBe("متعدد: STC، Zain");
    expect(screen.getByTestId("sim-type-value").getAttribute("data-state")).toBe("MIXED");
  });

  it("shows nothing before any lookup, and nothing for a serial that was not found", () => {
    const { rerender } = render(<SimTypeField rows={[{ value: "", lookup: null }]} />);
    expect(screen.getByTestId("sim-type-value").textContent).toBe("—");
    rerender(<SimTypeField rows={[{ value: "89966", lookup: { found: false } }]} />);
    expect(screen.getByTestId("sim-type-value").textContent).toBe("—");
    expect(screen.queryByTestId("sim-type-unavailable")).toBeNull();
  });
});
