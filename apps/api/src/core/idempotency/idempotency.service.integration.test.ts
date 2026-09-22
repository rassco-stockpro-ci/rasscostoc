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

describe("Governance — Idempotency atomic claim and stale recovery", () => {
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

  it("reclaims a stale PROCESSING record and completes the logical operation", async () => {
    const key = `GOV-IDEM-STALE-${randomUUID()}`;
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
          return { recovered: true };
        }
      )
    ).resolves.toEqual({ recovered: true });

    expect(calls).toBe(1);

    const [row] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.idempotencyKey, key));

    expect(row?.status).toBe("COMPLETED");
    expect(row?.completedAt).toBeTruthy();
  });
});
