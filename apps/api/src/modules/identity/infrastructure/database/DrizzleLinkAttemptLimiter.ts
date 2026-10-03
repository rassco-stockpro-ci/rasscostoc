import { sql } from "drizzle-orm";
import { getDatabase } from "@core/database/connection";
import type { ILinkAttemptLimiter } from "../../domain/repositories/ILinkAttemptLimiter";

/**
 * Same shared counter table and the same single atomic upsert as the request rate limiter
 * (rate_limit_counters): concurrent attempts, in this process or another, never lose an increment,
 * and the window rolls over on its own once reset_at has passed.
 */
export class DrizzleLinkAttemptLimiter implements ILinkAttemptLimiter {
  async hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const newResetAt = new Date(Date.now() + windowMs);
    const result = await getDatabase().execute(sql`
      INSERT INTO rate_limit_counters (key, count, reset_at)
      VALUES (${key}, 1, ${newResetAt})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN rate_limit_counters.reset_at <= now() THEN 1 ELSE rate_limit_counters.count + 1 END,
        reset_at = CASE WHEN rate_limit_counters.reset_at <= now() THEN ${newResetAt} ELSE rate_limit_counters.reset_at END
      RETURNING count, reset_at
    `);
    const row = result.rows[0] as { count: number; reset_at: string };
    return { count: Number(row.count), resetAt: new Date(row.reset_at).getTime() };
  }

  async clear(key: string): Promise<void> {
    await getDatabase().execute(sql`DELETE FROM rate_limit_counters WHERE key = ${key}`);
  }
}
