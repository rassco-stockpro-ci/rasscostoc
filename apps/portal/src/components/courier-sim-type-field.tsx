import { SIM_TYPE_UNAVAILABLE_MESSAGE, deriveSimTypes, type SimRowLike } from "@/lib/sim-type";

/**
 * "نوع الشريحة" on the close form: READ-ONLY, derived from the inventory data
 * the serial lookup returned for the SIM(s). It is not a selector — the type
 * is a property of the SIM item, so the technician cannot pick a different one.
 */
export function SimTypeField({
  rows,
  labelClassName = "block text-[10px] text-slate-450 mb-1 font-medium",
  boxClassName = "w-full rassco-glass border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135]",
}: {
  rows: SimRowLike[];
  labelClassName?: string;
  boxClassName?: string;
}) {
  const derived = deriveSimTypes(rows);
  return (
    <div data-testid="sim-type-field">
      <label className={labelClassName}>نوع الشريحة</label>
      <div
        role="textbox"
        aria-readonly="true"
        data-testid="sim-type-value"
        data-state={derived.state}
        className={boxClassName}
      >
        {derived.label}
      </div>
      {derived.code === "SIM_TYPE_UNAVAILABLE" && (
        <p data-testid="sim-type-unavailable" className="mt-1 text-[10px] text-amber-600">
          {SIM_TYPE_UNAVAILABLE_MESSAGE}
        </p>
      )}
    </div>
  );
}
