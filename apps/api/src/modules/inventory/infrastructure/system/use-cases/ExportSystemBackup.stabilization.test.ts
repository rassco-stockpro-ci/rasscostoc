/**
 * TEMP-SYSTEM-STABILIZATION-F2 — regression test C: backup password exclusion.
 *
 * Root cause: ExportSystemBackupUseCase did `db.select().from(users)` (every
 * column, including the bcrypt password hash) into a downloadable backup
 * file. Fixed with an explicit column selection that omits password.
 *
 * The key requirement per directive: the KEY must not exist at all in the
 * output — not just be empty/null/redacted.
 */
import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../../../../core/config/db";
import { users } from "@shared/schema";
import { ExportSystemBackupUseCase } from "./ExportSystemBackup.use-case";

describe("TEMP-STABILIZATION — ExportSystemBackupUseCase excludes password", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL must be an isolated test database.");
    }
  });

  const createdUserIds: string[] = [];
  const distinctivePassword = "STAB-DISTINCTIVE-SECRET-HASH-VALUE-9f8e7d";

  afterEach(async () => {
    for (const id of createdUserIds.splice(0)) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
  });

  it("backup output contains no 'password' key at all for any user, and never the secret value", async () => {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      username: `stab-backup-${id.slice(0, 8)}`,
      email: `stab-backup-${id.slice(0, 8)}@test.local`,
      password: distinctivePassword,
      fullName: "Stabilization Backup Test User",
      role: "technician",
    });
    createdUserIds.push(id);

    const useCase = new ExportSystemBackupUseCase();
    const result = await useCase.execute();

    const thisUser = (result.data.users as any[]).find((u) => u.id === id);
    expect(thisUser).toBeDefined();

    // The key itself must not exist — not just be falsy.
    expect(Object.prototype.hasOwnProperty.call(thisUser, "password")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(thisUser, "passwordHash")).toBe(false);

    // Belt-and-suspenders: the secret value must not appear ANYWHERE in the
    // serialized backup, in case it leaked into some other field/table.
    const fullSerialized = JSON.stringify(result.data);
    expect(fullSerialized).not.toContain(distinctivePassword);

    // Sanity: confirm this isn't a false pass because the whole users array
    // is empty — it must actually contain our seeded row with real fields.
    expect(thisUser.username).toContain("stab-backup-");
    expect(thisUser.role).toBe("technician");
  });
});
