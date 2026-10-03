/**
 * Telegram self-link — a technician proves who they are with their RASSCO username + password and the
 * bot links its Telegram account to that user.
 *
 * Order matters (every step refuses before the next one can leak anything):
 *   1. attempt limits (per Telegram id and per target account) — counted before any check, so guessing is capped;
 *   2. credentials — an unknown user and a wrong password are indistinguishable (same error, same bcrypt cost);
 *   3. only after a VALID password: account must be active, role must be technician;
 *   4. one transaction: lock the user, re-check state, refuse an existing link / a Telegram id already used by
 *      another user, link, audit.
 *
 * Nothing here ever stores, logs or returns the password or its hash.
 */
import crypto from "crypto";
import { AppError, AuthenticationError } from "@core/errors/AppError";
import { hashPassword, verifyPassword } from "@server/utils/password";
import type { IUserRepository } from "@stockpro/contracts";
import type { ITelegramLinkRepository } from "../../domain/repositories/ITelegramLinkRepository";
import type { ILinkAttemptLimiter } from "../../domain/repositories/ILinkAttemptLimiter";
import type { IdentityAuditEntry } from "../../domain/repositories/IIdentityUnitOfWork";

export const LINK_WINDOW_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS_PER_TELEGRAM_ID = 5;
export const MAX_ATTEMPTS_PER_ACCOUNT = 10;
export const LINKABLE_ROLE = "technician";

export const INVALID_CREDENTIALS_MESSAGE = "اسم المستخدم أو كلمة المرور غير صحيحة";

export type LinkTelegramInput = {
  telegramUserId: string;
  telegramUsername?: string | null;
  username: string;
  password: string;
};

export type LinkTelegramResult = {
  linked: true;
  alreadyLinked: boolean;
  technician: { id: string; name: string; username: string; technicianCode: string | null };
};

const BOT_ACTOR = { userName: "telegram-bot", userRole: "system" } as const;

// A real bcrypt hash of a random value, built once: an unknown username costs the same bcrypt compare as a wrong password.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomUUID()));

const sha = (value: string) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);

export class LinkTelegramAccountUseCase {
  constructor(
    private readonly users: IUserRepository,
    private readonly links: ITelegramLinkRepository,
    private readonly limiter: ILinkAttemptLimiter
  ) {}

  async execute(input: LinkTelegramInput): Promise<LinkTelegramResult> {
    const telegramUserId = input.telegramUserId.trim().replace(/^@/, "");
    const telegramUsername = input.telegramUsername?.trim().replace(/^@/, "") || null;
    const accountKey = input.username.trim().toLowerCase();

    await this.enforceAttemptLimits(telegramUserId, accountKey);

    const user = await this.users.getUserByUsername(input.username);
    const hash = user?.password ?? (await getDummyHash());
    const passwordOk = await verifyPassword(input.password, hash);
    if (!user || !passwordOk) {
      await this.refuse(user?.id ?? null, user?.id ?? "unknown", telegramUserId, "INVALID_CREDENTIALS", "بيانات الدخول غير صحيحة");
      throw new AuthenticationError(INVALID_CREDENTIALS_MESSAGE);
    }

    // The password is valid from here on: it is now safe to say why a link is refused.
    if (!user.isActive) {
      await this.refuse(user.id, user.id, telegramUserId, "ACCOUNT_INACTIVE", "الحساب غير نشط");
      throw new AppError("الحساب غير نشط", 403, true, "ACCOUNT_INACTIVE");
    }
    if (user.role !== LINKABLE_ROLE) {
      await this.refuse(user.id, user.id, telegramUserId, "ROLE_NOT_ALLOWED", "الدور غير مسموح");
      throw new AppError("ربط Telegram عبر البوت متاح لحسابات الفنيين فقط", 403, true, "ROLE_NOT_ALLOWED");
    }

    const outcome = await this.links.link({
      userId: user.id,
      telegramUserId,
      telegramUsername,
      allowedRole: LINKABLE_ROLE,
      successAudit: {
        userId: user.id,
        ...BOT_ACTOR,
        action: "telegram-link",
        entityType: "user",
        entityId: user.id,
        entityName: user.username,
        description: `تم ربط حساب Telegram (id=${telegramUserId}${telegramUsername ? ` @${telegramUsername}` : ""}) بالفني عبر البوت`,
        severity: "info",
        success: true,
      },
    });

    switch (outcome) {
      case "LINKED":
      case "ALREADY_LINKED_SAME":
        await Promise.all([
          this.limiter.clear(`tglink:tg:${telegramUserId}`),
          this.limiter.clear(`tglink:acct:${sha(accountKey)}`),
        ]);
        return {
          linked: true,
          alreadyLinked: outcome === "ALREADY_LINKED_SAME",
          technician: { id: user.id, name: user.fullName, username: user.username, technicianCode: user.technicianCode ?? null },
        };
      case "ACCOUNT_LINKED_TO_OTHER":
        await this.refuse(user.id, user.id, telegramUserId, outcome, "الحساب مربوط بمعرّف Telegram آخر");
        throw new AppError("هذا الحساب مربوط بحساب Telegram آخر. تغيير الربط يتم عن طريق المشرف فقط", 409, true, "TELEGRAM_ACCOUNT_ALREADY_LINKED");
      case "TELEGRAM_ID_TAKEN":
        await this.refuse(user.id, user.id, telegramUserId, outcome, "معرّف Telegram مربوط بمستخدم آخر");
        throw new AppError("حساب Telegram هذا مربوط بمستخدم آخر. تواصل مع المشرف", 409, true, "TELEGRAM_ID_ALREADY_USED");
      case "ACCOUNT_INACTIVE":
        throw new AppError("الحساب غير نشط", 403, true, "ACCOUNT_INACTIVE");
      case "ROLE_NOT_ALLOWED":
        throw new AppError("ربط Telegram عبر البوت متاح لحسابات الفنيين فقط", 403, true, "ROLE_NOT_ALLOWED");
      default:
        throw new AuthenticationError(INVALID_CREDENTIALS_MESSAGE);
    }
  }

  private async enforceAttemptLimits(telegramUserId: string, accountKey: string): Promise<void> {
    const [byTelegram, byAccount] = await Promise.all([
      this.limiter.hit(`tglink:tg:${telegramUserId}`, LINK_WINDOW_MS),
      this.limiter.hit(`tglink:acct:${sha(accountKey)}`, LINK_WINDOW_MS),
    ]);
    const exceeded =
      byTelegram.count > MAX_ATTEMPTS_PER_TELEGRAM_ID
        ? byTelegram
        : byAccount.count > MAX_ATTEMPTS_PER_ACCOUNT
          ? byAccount
          : null;
    if (exceeded) {
      const minutes = Math.max(1, Math.ceil((exceeded.resetAt - Date.now()) / 60000));
      throw new AppError(`تجاوزت عدد محاولات الربط المسموح. حاول بعد ${minutes} دقيقة`, 429, true, "TELEGRAM_LINK_RATE_LIMITED");
    }
  }

  private async refuse(
    userId: string | null,
    entityId: string,
    telegramUserId: string,
    reason: string,
    detail: string
  ): Promise<void> {
    const entry: IdentityAuditEntry = {
      userId,
      ...BOT_ACTOR,
      action: "telegram-link-failed",
      entityType: "user",
      entityId,
      entityName: entityId,
      description: `رُفض ربط Telegram (id=${telegramUserId}): ${detail} [${reason}]`,
      severity: "warn",
      success: false,
    };
    await this.links.recordFailure(entry);
  }
}
