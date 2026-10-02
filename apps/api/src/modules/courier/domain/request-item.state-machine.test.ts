import { describe, expect, it } from "vitest";
import {
  REQUEST_ITEM_STATUSES,
  REQUEST_ITEM_TRANSITIONS,
  RESERVED_REQUEST_ITEM_STATUSES,
  RequestItemTransitionError,
  assertRequestItemTransition,
  isRequestItemTransitionAllowed,
} from "./request-item.state-machine";

describe("request item state machine", () => {
  it("defines exactly the approved transitions", () => {
    expect(REQUEST_ITEM_TRANSITIONS.map((t) => `${t.from ?? "new"} -${t.action}-> ${t.to}`)).toEqual([
      "new -ASSIGN-> PENDING_RECEIPT",
      "new -BIND_AT_CLOSE-> RECEIVED",
      "PENDING_RECEIPT -RECEIVE-> RECEIVED",
      "RECEIVED -RECEIVE-> RECEIVED",
      "RECEIVED -INSTALL-> INSTALLED",
    ]);
  });

  it("reserved statuses (DELIVERED, REJECTED, MISSING) are neither reached nor left by any transition", () => {
    expect([...RESERVED_REQUEST_ITEM_STATUSES].sort()).toEqual(["DELIVERED", "MISSING", "REJECTED"]);
    for (const s of RESERVED_REQUEST_ITEM_STATUSES) {
      expect(REQUEST_ITEM_TRANSITIONS.some((t) => t.to === s || t.from === s)).toBe(false);
    }
  });

  it("every status in a transition is a schema status", () => {
    for (const t of REQUEST_ITEM_TRANSITIONS) {
      expect(REQUEST_ITEM_STATUSES).toContain(t.to);
      if (t.from) expect(REQUEST_ITEM_STATUSES).toContain(t.from);
    }
  });

  it("receiving accepts RECEIVED only", () => {
    expect(isRequestItemTransitionAllowed("PENDING_RECEIPT", "RECEIVE", "RECEIVED")).toBe(true);
    for (const to of ["MISSING", "REJECTED", "INSTALLED", "DELIVERED", "PENDING_RECEIPT"]) {
      expect(isRequestItemTransitionAllowed("PENDING_RECEIPT", "RECEIVE", to)).toBe(false);
    }
  });

  it("installing requires RECEIVED; nothing installs a reserved or pending item", () => {
    expect(isRequestItemTransitionAllowed("RECEIVED", "INSTALL", "INSTALLED")).toBe(true);
    expect(isRequestItemTransitionAllowed("PENDING_RECEIPT", "INSTALL", "INSTALLED")).toBe(false);
    expect(isRequestItemTransitionAllowed("INSTALLED", "INSTALL", "INSTALLED")).toBe(false);
  });

  it("a rejected transition is a 422 with a stable code", () => {
    const err = (() => {
      try {
        assertRequestItemTransition("PENDING_RECEIPT", "RECEIVE", "MISSING");
      } catch (e) {
        return e as RequestItemTransitionError;
      }
    })();
    expect(err).toBeInstanceOf(RequestItemTransitionError);
    expect(err!.statusCode).toBe(422);
    expect(err!.code).toBe("REQUEST_ITEM_TRANSITION_INVALID");
  });
});
