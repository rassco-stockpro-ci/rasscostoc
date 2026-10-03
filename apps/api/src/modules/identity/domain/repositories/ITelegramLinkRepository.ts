import type { IdentityAuditEntry } from "./IIdentityUnitOfWork";

/**
 * What happened when a verified technician asked to link a Telegram account.
 * Decided inside ONE transaction that holds the user row lock, so two concurrent
 * links can never both succeed for the same user or the same Telegram id.
 */
export type TelegramLinkOutcome =
  | "LINKED"
  | "ALREADY_LINKED_SAME" // this user is already linked to this very Telegram id (idempotent success)
  | "ACCOUNT_LINKED_TO_OTHER" // this user is already linked to a different Telegram id
  | "TELEGRAM_ID_TAKEN" // this Telegram id is linked to another user
  | "ACCOUNT_INACTIVE" // deactivated between the credential check and the lock
  | "ROLE_NOT_ALLOWED" // role changed between the credential check and the lock
  | "USER_NOT_FOUND";

export type TelegramLinkRequest = {
  userId: string;
  /** Numeric Telegram user id as text (the form stored in users.telegram_user_id). */
  telegramUserId: string;
  telegramUsername: string | null;
  allowedRole: string;
  /** Written in the same transaction when the outcome is LINKED. */
  successAudit: IdentityAuditEntry;
};

export interface ITelegramLinkRepository {
  /** Lock the user, re-check state, link, and audit — atomically. */
  link(request: TelegramLinkRequest): Promise<TelegramLinkOutcome>;
  /** One audit row for a refused/failed attempt (never contains a password). */
  recordFailure(entry: IdentityAuditEntry): Promise<void>;
}
