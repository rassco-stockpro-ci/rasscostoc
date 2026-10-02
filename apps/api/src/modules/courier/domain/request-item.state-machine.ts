/**
 * Courier request item lifecycle (courier_request_items.status).
 *
 * Domain decisions (product owner, 2026-10-02):
 *   - a successful close moves the items it installs RECEIVED -> INSTALLED,
 *     on every channel (portal, PDF approval/apply, mobile attempt); request
 *     items not part of that close keep their status;
 *   - receiving (scan, confirm-receiving) accepts RECEIVED only, and only for
 *     an item of the same request;
 *   - DELIVERED, REJECTED and MISSING are reserved: no transition reaches or
 *     leaves them until a future decision defines one.
 *
 *   FROM              ACTION          TO               ACTOR / CHANNEL
 *   (new row)         ASSIGN          PENDING_RECEIPT  dispatcher (portal: assign items);
 *                                                      technician (mobile: accept request)
 *   (new row)         BIND_AT_CLOSE   RECEIVED         closing user (portal close, PDF approve/apply)
 *                                                      for a validated custody serial not yet linked
 *   PENDING_RECEIPT   RECEIVE         RECEIVED         technician (mobile: scan, confirm-receiving);
 *                                                      implied at close for a linked serial whose
 *                                                      custody the close guard just validated
 *   RECEIVED          RECEIVE         RECEIVED         idempotent re-receive (mobile)
 *   RECEIVED          INSTALL         INSTALLED        successful close, all channels, close items only
 *
 * The Telegram bot and the outbox worker write no request item state.
 */
import { AppError } from "@core/errors/AppError";

export const REQUEST_ITEM_STATUSES = ["PENDING_RECEIPT", "RECEIVED", "INSTALLED", "DELIVERED", "REJECTED", "MISSING"] as const;
export type RequestItemStatus = (typeof REQUEST_ITEM_STATUSES)[number];

/** Defined in the schema, reachable by no transition (reserved). */
export const RESERVED_REQUEST_ITEM_STATUSES: readonly RequestItemStatus[] = ["DELIVERED", "REJECTED", "MISSING"];

export type RequestItemAction = "ASSIGN" | "BIND_AT_CLOSE" | "RECEIVE" | "INSTALL";

export interface RequestItemTransition {
  from: RequestItemStatus | null; // null: the row is being created
  action: RequestItemAction;
  to: RequestItemStatus;
}

export const REQUEST_ITEM_TRANSITIONS: readonly RequestItemTransition[] = [
  { from: null, action: "ASSIGN", to: "PENDING_RECEIPT" },
  { from: null, action: "BIND_AT_CLOSE", to: "RECEIVED" },
  { from: "PENDING_RECEIPT", action: "RECEIVE", to: "RECEIVED" },
  { from: "RECEIVED", action: "RECEIVE", to: "RECEIVED" },
  { from: "RECEIVED", action: "INSTALL", to: "INSTALLED" },
];

export class RequestItemTransitionError extends AppError {
  constructor(
    readonly from: string | null,
    readonly action: RequestItemAction,
    readonly to: string
  ) {
    super(
      `انتقال غير مسموح لحالة عنصر الطلب: ${from ?? "(جديد)"} → ${to} (${action}).`,
      422,
      true,
      "REQUEST_ITEM_TRANSITION_INVALID"
    );
    this.name = "RequestItemTransitionError";
  }
}

export function isRequestItemTransitionAllowed(from: string | null, action: RequestItemAction, to: string): boolean {
  return REQUEST_ITEM_TRANSITIONS.some((t) => t.from === from && t.action === action && t.to === to);
}

/** @throws RequestItemTransitionError (422) when the transition is not defined above. */
export function assertRequestItemTransition(from: string | null, action: RequestItemAction, to: string): void {
  if (!isRequestItemTransitionAllowed(from, action, to)) {
    throw new RequestItemTransitionError(from, action, to);
  }
}
