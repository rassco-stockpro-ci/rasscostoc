import { beforeAll, describe, expect, it } from "vitest";
import type { IUserRepository } from "@stockpro/contracts";
import { hashPassword } from "@server/utils/password";
import type { IdentityAuditEntry } from "../../domain/repositories/IIdentityUnitOfWork";
import type { ITelegramLinkRepository, TelegramLinkOutcome, TelegramLinkRequest } from "../../domain/repositories/ITelegramLinkRepository";
import type { ILinkAttemptLimiter } from "../../domain/repositories/ILinkAttemptLimiter";
import {
  INVALID_CREDENTIALS_MESSAGE,
  LinkTelegramAccountUseCase,
  MAX_ATTEMPTS_PER_ACCOUNT,
  MAX_ATTEMPTS_PER_TELEGRAM_ID,
} from "./LinkTelegramAccount.use-case";

const PASSWORD = "S3cret!pw-for-test";
let HASH = "";
beforeAll(async () => {
  HASH = await hashPassword(PASSWORD);
});

type FakeUser = { id: string; username: string; fullName: string; role: string; isActive: boolean; technicianCode: string | null; password: string };
const user = (over: Partial<FakeUser> = {}): FakeUser => ({
  id: "u-1", username: "Tech.One", fullName: "فني تجريبي", role: "technician", isActive: true, technicianCode: "T-1", password: HASH, ...over,
});

function build(opts: { users?: FakeUser[]; outcome?: TelegramLinkOutcome } = {}) {
  const found = opts.users ?? [user()];
  const lookups: string[] = [];
  const users = {
    getUserByUsername: async (name: string) => {
      lookups.push(name);
      return found.find((u) => u.username.toLowerCase() === name.trim().toLowerCase());
    },
  } as unknown as IUserRepository;
  const linkRequests: TelegramLinkRequest[] = [];
  const failures: IdentityAuditEntry[] = [];
  const links: ITelegramLinkRepository = {
    link: async (r) => (linkRequests.push(r), opts.outcome ?? "LINKED"),
    recordFailure: async (e) => void failures.push(e),
  };
  const counts = new Map<string, number>();
  const cleared: string[] = [];
  const limiter: ILinkAttemptLimiter = {
    hit: async (key, windowMs) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { count: counts.get(key)!, resetAt: Date.now() + windowMs };
    },
    clear: async (key) => void (cleared.push(key), counts.delete(key)),
  };
  return { uc: new LinkTelegramAccountUseCase(users, links, limiter), lookups, linkRequests, failures, cleared, counts };
}

const input = (over: Record<string, unknown> = {}) => ({ telegramUserId: "700000001", telegramUsername: "tech_one", username: "Tech.One", password: PASSWORD, ...over });
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { statusCode?: number; code?: string; message: string };
  }
  throw new Error("expected a refusal");
};

describe("LinkTelegramAccountUseCase", () => {
  it("links an active technician with valid credentials and returns only safe fields", async () => {
    const t = build();
    const r = await t.uc.execute(input({ username: "  tech.one " }));
    expect(r).toEqual({ linked: true, alreadyLinked: false, technician: { id: "u-1", name: "فني تجريبي", username: "Tech.One", technicianCode: "T-1" } });
    expect(t.linkRequests).toHaveLength(1);
    expect(t.linkRequests[0]).toMatchObject({ userId: "u-1", telegramUserId: "700000001", telegramUsername: "tech_one", allowedRole: "technician" });
    expect(t.linkRequests[0]!.successAudit).toMatchObject({ action: "telegram-link", userId: "u-1", success: true });
    expect(JSON.stringify(r)).not.toContain(HASH);
  });

  it("normalizes the Telegram id and username (leading @ and spaces)", async () => {
    const t = build();
    await t.uc.execute(input({ telegramUserId: " @700000001 ", telegramUsername: "@tech_one " }));
    expect(t.linkRequests[0]).toMatchObject({ telegramUserId: "700000001", telegramUsername: "tech_one" });
    const t2 = build();
    await t2.uc.execute(input({ telegramUsername: null }));
    expect(t2.linkRequests[0]!.telegramUsername).toBeNull();
  });

  it("an unknown user and a wrong password get the SAME refusal, and neither reaches the link step", async () => {
    const t = build();
    const wrongPw = await fails(t.uc.execute(input({ password: "nope" })));
    const unknown = await fails(t.uc.execute(input({ username: "ghost" })));
    for (const e of [wrongPw, unknown]) {
      expect(e.statusCode).toBe(401);
      expect(e.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    }
    expect(wrongPw.message).toBe(unknown.message);
    expect(t.linkRequests).toHaveLength(0);
    expect(t.failures.map((f) => f.description)).toEqual([expect.stringContaining("INVALID_CREDENTIALS"), expect.stringContaining("INVALID_CREDENTIALS")]);
    expect(t.failures[1]!.userId).toBeNull(); // unknown user: no FK, nothing invented
  });

  it("inactivity and role are only revealed AFTER a valid password", async () => {
    const t = build({ users: [user({ isActive: false }), user({ id: "u-2", username: "Boss", role: "admin" })] });
    expect((await fails(t.uc.execute(input({ password: "nope" })))).statusCode).toBe(401);
    expect((await fails(t.uc.execute(input({ username: "Boss", password: "nope" })))).statusCode).toBe(401);
    const inactive = await fails(t.uc.execute(input()));
    expect([inactive.statusCode, inactive.code]).toEqual([403, "ACCOUNT_INACTIVE"]);
    const admin = await fails(t.uc.execute(input({ username: "Boss" })));
    expect([admin.statusCode, admin.code]).toEqual([403, "ROLE_NOT_ALLOWED"]);
    expect(t.linkRequests).toHaveLength(0);
  });

  it("an existing link is refused, a Telegram id used by another user is refused, the same link again is idempotent", async () => {
    const other = await fails(build({ outcome: "ACCOUNT_LINKED_TO_OTHER" }).uc.execute(input()));
    expect([other.statusCode, other.code]).toEqual([409, "TELEGRAM_ACCOUNT_ALREADY_LINKED"]);
    const taken = await fails(build({ outcome: "TELEGRAM_ID_TAKEN" }).uc.execute(input()));
    expect([taken.statusCode, taken.code]).toEqual([409, "TELEGRAM_ID_ALREADY_USED"]);
    const same = await build({ outcome: "ALREADY_LINKED_SAME" }).uc.execute(input());
    expect(same.alreadyLinked).toBe(true);
  });

  it("race outcomes decided under the row lock are refused too", async () => {
    expect((await fails(build({ outcome: "ACCOUNT_INACTIVE" }).uc.execute(input()))).code).toBe("ACCOUNT_INACTIVE");
    expect((await fails(build({ outcome: "ROLE_NOT_ALLOWED" }).uc.execute(input()))).code).toBe("ROLE_NOT_ALLOWED");
    expect((await fails(build({ outcome: "USER_NOT_FOUND" }).uc.execute(input()))).statusCode).toBe(401);
  });

  it("caps attempts per Telegram id: the next attempt is a 429 before any user lookup, even with the right password", async () => {
    const t = build();
    for (let i = 0; i < MAX_ATTEMPTS_PER_TELEGRAM_ID; i++) await fails(t.uc.execute(input({ password: "nope" })));
    const lookupsBefore = t.lookups.length;
    const limited = await fails(t.uc.execute(input()));
    expect([limited.statusCode, limited.code]).toEqual([429, "TELEGRAM_LINK_RATE_LIMITED"]);
    expect(t.lookups.length).toBe(lookupsBefore);
    expect(t.linkRequests).toHaveLength(0);
  });

  it("caps attempts per target account across different Telegram ids", async () => {
    const t = build();
    for (let i = 0; i < MAX_ATTEMPTS_PER_ACCOUNT; i++) await fails(t.uc.execute(input({ telegramUserId: String(710000000 + i), password: "nope" })));
    const limited = await fails(t.uc.execute(input({ telegramUserId: "720000000" })));
    expect(limited.code).toBe("TELEGRAM_LINK_RATE_LIMITED");
  });

  it("a successful link resets both counters", async () => {
    const t = build();
    await fails(t.uc.execute(input({ password: "nope" })));
    await t.uc.execute(input());
    expect(t.cleared).toHaveLength(2);
    expect(t.cleared[0]).toBe("tglink:tg:700000001");
    expect(t.cleared[1]).toMatch(/^tglink:acct:[0-9a-f]{32}$/); // hashed: the raw username is never a key
  });

  it("the password and its hash never appear in audit entries, errors or counter keys", async () => {
    const t = build({ outcome: "TELEGRAM_ID_TAKEN" });
    const errors = [await fails(t.uc.execute(input({ password: "wrong-pw-xyz" }))), await fails(t.uc.execute(input()))];
    const everything = JSON.stringify([t.failures, errors.map((e) => e.message), [...t.counts.keys()], t.linkRequests]);
    for (const secret of [PASSWORD, "wrong-pw-xyz", HASH]) expect(everything).not.toContain(secret);
  });
});
