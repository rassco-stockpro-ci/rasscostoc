/**
 * Public contract of the inventory module's custody policy, for other modules
 * (courier guards, adapters). Side-effect free: importing it does not load any
 * inventory service or database code.
 */
export {
  ACTIVE_CUSTODY_STATUSES,
  isActiveCustodyStatus,
  isInActiveCustodyOf,
  type ActiveCustodyStatus,
} from "../domain/active-custody.policy";
