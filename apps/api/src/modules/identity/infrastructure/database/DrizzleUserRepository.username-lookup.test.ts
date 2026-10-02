/**
 * Production parity (03f7a1a): usernames are matched ignoring case and
 * surrounding whitespace, as Production does today (72 of its 89 usernames
 * contain upper case or spaces). Real PostgreSQL — the comparison is SQL
 * (LOWER(TRIM(username))), so a mocked repository could not prove it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../../../core/config/db";
import { users, regions } from "@shared/schema";
import { hashPassword } from "../../../../utils/password";
import { DrizzleUserRepository } from "./DrizzleUserRepository";

describe("DrizzleUserRepository.getUserByUsername — case/whitespace-insensitive (Production parity)", () => {
  const repo = new DrizzleUserRepository();
  const regionId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const stored = `Ahmed.Ali.${tag}`;
  let id: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("test")) {
      throw new Error("Refusing to run: DATABASE_URL does not look like an isolated test database.");
    }
    await db.insert(regions).values({ id: regionId, name: `Username Lookup Region ${tag}` });
    id = randomUUID();
    await repo.createUser({
      id,
      username: stored,
      email: `lookup.${tag}@test.invalid`,
      password: await hashPassword("LookupTest!1"),
      fullName: "Username Lookup",
      role: "technician",
      regionId,
    } as any);
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.regionId, regionId));
    await db.delete(regions).where(eq(regions.id, regionId));
  });

  it("finds the user whatever the case and surrounding whitespace", async () => {
    for (const typed of [stored, stored.toLowerCase(), stored.toUpperCase(), `  ${stored.toLowerCase()}  `]) {
      expect((await repo.getUserByUsername(typed))?.id, typed).toBe(id);
    }
  });

  it("does not match a different username or an empty one", async () => {
    expect(await repo.getUserByUsername(`ahmed.ali.${tag}x`)).toBeUndefined();
    expect(await repo.getUserByUsername("   ")).toBeUndefined();
    expect(await repo.getUserByUsername("")).toBeUndefined();
  });

  it("a second account differing only by case is refused (uniqueness follows the same rule)", async () => {
    await expect(
      repo.createUser({
        id: randomUUID(),
        username: stored.toLowerCase(),
        email: `lookup2.${tag}@test.invalid`,
        password: await hashPassword("LookupTest!1"),
        fullName: "Duplicate",
        role: "technician",
        regionId,
      } as any)
    ).rejects.toThrow("Username already exists");
  });
});
