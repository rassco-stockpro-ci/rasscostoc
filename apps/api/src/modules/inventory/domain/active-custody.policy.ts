/**
 * ActiveCustodyPolicy — the single definition of "a technician actively holds
 * this serialized item".
 *
 * Domain decision (2026-10-02, product owner): IN_TRANSIT — the technician
 * started the task and is carrying the item to the customer (courier
 * startTask) — IS active custody. An item in any of these statuses, owned by
 * a technician, can be closed (installed) and deducted from that technician.
 *
 * Every custody consumer — courier close guards, the deduction scan-out,
 * serial lookup, technician custody listings, deactivation and transfer
 * checks — uses this policy. Never re-declare the status list elsewhere.
 */
export const ACTIVE_CUSTODY_STATUSES = ["IN_TRANSIT_CUSTODY", "RECEIVED_BY_TECHNICIAN", "IN_TRANSIT"] as const;

export type ActiveCustodyStatus = (typeof ACTIVE_CUSTODY_STATUSES)[number];

export function isActiveCustodyStatus(status: string | null | undefined): status is ActiveCustodyStatus {
  return !!status && (ACTIVE_CUSTODY_STATUSES as readonly string[]).includes(status);
}

/** The item is in active custody of exactly this technician. */
export function isInActiveCustodyOf(
  item: { status: string | null | undefined; currentOwnerId: string | null | undefined },
  technicianId: string
): boolean {
  return item.currentOwnerId === technicianId && isActiveCustodyStatus(item.status);
}
