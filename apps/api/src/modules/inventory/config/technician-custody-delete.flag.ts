/**
 * TEMPORARY FEATURE — remove or disable after final customer handover.
 *
 * Controls whether a technician may permanently delete a serialized item
 * (device/SIM) from their own active custody via
 * DELETE /api/serialized-items/my-custody/:serialNumber.
 *
 * Disabling requires no migration and no database access — set the
 * environment variable to anything other than "true" (or unset it) and
 * restart the API process. Default is disabled (fail closed).
 */
export function isTechnicianCustodyDeleteEnabled(): boolean {
  return process.env.ENABLE_TECHNICIAN_CUSTODY_DELETE === "true";
}

/**
 * TEMPORARY FEATURE — remove after final inventory workflow is released.
 *
 * Controls whether a technician may permanently delete a serialized item
 * (device/SIM) they currently hold OR themselves delivered, by its own
 * database id, via DELETE /api/inventory/my-custody/serialized-items/:itemId.
 *
 * Deliberately a SEPARATE flag from isTechnicianCustodyDeleteEnabled() above
 * (a different, independent environment variable) — even though both guard
 * similarly-shaped temporary technician-delete routes, they must be
 * switchable independently: turning either one off must never affect the
 * other, and neither route's code needs to change to flip either flag.
 *
 * Disabling requires no migration and no database access — set the
 * environment variable to anything other than "true" (or unset it, which is
 * the current production state) and restart/reload the API process. Default
 * is disabled (fail closed) — this feature stays off even after a future
 * build+deploy of this source change until this variable is explicitly set.
 */
export function isTechnicianDeleteByIdEnabled(): boolean {
  return process.env.ENABLE_TECHNICIAN_CUSTODY_DELETE_BY_ID === "true";
}
