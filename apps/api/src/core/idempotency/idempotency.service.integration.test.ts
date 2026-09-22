/**
 * Governance regression: idempotency claim concurrency and stale recovery.
 *
 * Real disposable PostgreSQL only. This protects the custody/inventory
 * subscriber contract from concurrent duplicate execution and from a process
 * dying after the business action commits but before COMPLETED is recorded.
 */
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../config/db";
import { idempotencyRecords } from "@shared/schema";
import { idempotencyService } from "./idempotency.service";

describe("Governance — Idempotency atomic claim and evidence recovery", () => {
  const keys: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error(
        "Refusing to run: DATABASE_URL does not look like an isolated test database."
      );
    }
  });

  afterEach(async () => {
    for (const key of keys.splice(0)) {
      await db.delete(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, key))
        .catch(() => {});
    }
  });

  it("serializes a concurrent first-seen claim so only one action runs", async () => {
    const key = `GOV-IDEM-CONCURRENT-${randomUUID()}`;
    keys.push(key);

    let actionCalls = 0;
    let release!: () => void;
    const actionFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    let actionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      actionStarted = resolve;
    });

    const first = idempotencyService.execute(
      key,
      randomUUID(),
      "GovernanceTest",
      async () => {
        actionCalls += 1;
        actionStarted();
        await actionFinished;
        return { ok: true };
      }
    );

    await started;

    const second = idempotencyService.execute(
      key,
      randomUUID(),
      "GovernanceTest",
      async () => {
        actionCalls += 1;
        return { ok: "duplicate" };
      }
    );

    await expect(second).rejects.toThrow(/currently PROCESSING/);

    release();
    await expect(first).resolves.toEqual({ ok: true });

    expect(actionCalls).toBe(1);
  });

  it("does not reclaim a PROCESSING record merely because it is old", async () => {
    const key = `GOV-IDEM-NO-STALE-RECLAIM-${randomUUID()}`;
    keys.push(key);

    await db.insert(idempotencyRecords).values({
      idempotencyKey: key,
      eventId: randomUUID(),
      subscriberName: "GovernanceTest",
      status: "PROCESSING",
      createdAt: new Date(Date.now() - 31 * 60 * 1000),
    });

    let calls = 0;

    await expect(
      idempotencyService.execute(
        key,
        randomUUID(),
        "GovernanceTest",
        async () => {
          calls += 1;
          return { shouldNotRun: true };
        }
      )
    ).rejects.toThrow(/currently PROCESSING/);

    expect(calls).toBe(0);
  });

  it("allows evidence-driven completion of an owned PROCESSING record", async () => {
    const key = `GOV-IDEM-EVIDENCE-${randomUUID()}`;
    const eventId = randomUUID();
    keys.push(key);

    await db.insert(idempotencyRecords).values({
      idempotencyKey: key,
      eventId,
      subscriberName: "GovernanceTest",
      status: "PROCESSING",
    });

    await expect(
      idempotencyService.completeIfProcessing(key, eventId, {
        success: true,
        recoveredFromDurableCompletion: true,
      })
    ).resolves.toBe(true);

    const [row] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.idempotencyKey, key));

    expect(row?.status).toBe("COMPLETED");
    expect(row?.responsePayload).toEqual({
      success: true,
      recoveredFromDurableCompletion: true,
    });
  });
});
