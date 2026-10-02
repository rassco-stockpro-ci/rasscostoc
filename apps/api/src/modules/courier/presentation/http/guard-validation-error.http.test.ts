/**
 * Presentation-layer HTTP test: a close rejected by a guard (or by its
 * in-transaction deduction) reaches the client as 422 with the Arabic reason,
 * never masked as 500. The policy itself is tested in the application layer
 * (application/guards/ConsumablesGuard.test.ts).
 */
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { GuardValidationError } from "../../application/guards/guard.types";
import { AppError } from "@core/errors/AppError";
import { errorHandler } from "@core/errors/errorHandler";

async function respond(error: Error) {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const app = express();
    app.post("/x", () => {
      throw error;
    });
    app.use(errorHandler);
    return await request(app).post("/x");
  } finally {
    process.env.NODE_ENV = prev;
  }
}

describe("close rejections over HTTP (production error handler)", () => {
  it("a guard rejection returns 422 with the Arabic reason and its code", async () => {
    const res = await respond(new GuardValidationError("رصيد الفني لا يكفي لإغلاق الطلب", "consumables"));
    expect(res.status).toBe(422);
    expect(res.body.message).toBe("رصيد الفني لا يكفي لإغلاق الطلب");
    expect(res.body.code).toBe("GUARD_VALIDATION_FAILED");
  });

  it("a refused deduction returns 422 / a transient one 503, each with its code", async () => {
    const rejected = await respond(new AppError("لم يُغلق الطلب: رصيد الفني لا يكفي للخصم.", 422, true, "INVENTORY_DEDUCTION_REJECTED"));
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe("INVENTORY_DEDUCTION_REJECTED");

    const transient = await respond(new AppError("لم يُغلق الطلب: خطأ مؤقت.", 503, true, "INVENTORY_DEDUCTION_TRANSIENT"));
    expect(transient.status).toBe(503);
    expect(transient.body.code).toBe("INVENTORY_DEDUCTION_TRANSIENT");
  });
});
