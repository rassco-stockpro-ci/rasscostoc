import { describe, expect, it } from "vitest";
import { ACTIVE_CUSTODY_STATUSES, isActiveCustodyStatus, isInActiveCustodyOf } from "./active-custody.policy";

describe("ActiveCustodyPolicy", () => {
  it("IN_TRANSIT is active custody (domain decision 2026-10-02), alongside IN_TRANSIT_CUSTODY and RECEIVED_BY_TECHNICIAN", () => {
    expect([...ACTIVE_CUSTODY_STATUSES].sort()).toEqual(["IN_TRANSIT", "IN_TRANSIT_CUSTODY", "RECEIVED_BY_TECHNICIAN"]);
    for (const s of ACTIVE_CUSTODY_STATUSES) expect(isActiveCustodyStatus(s)).toBe(true);
  });

  it("every other item status is not active custody", () => {
    for (const s of ["WAREHOUSE", "DELIVERED", "RETURNED", "PENDING_ACCEPTANCE", "", null, undefined]) {
      expect(isActiveCustodyStatus(s as any)).toBe(false);
    }
  });

  it("custody of a specific technician requires both ownership and an active status", () => {
    expect(isInActiveCustodyOf({ status: "IN_TRANSIT", currentOwnerId: "t1" }, "t1")).toBe(true);
    expect(isInActiveCustodyOf({ status: "IN_TRANSIT", currentOwnerId: "t2" }, "t1")).toBe(false);
    expect(isInActiveCustodyOf({ status: "DELIVERED", currentOwnerId: "t1" }, "t1")).toBe(false);
    expect(isInActiveCustodyOf({ status: "RECEIVED_BY_TECHNICIAN", currentOwnerId: null }, "t1")).toBe(false);
  });
});
