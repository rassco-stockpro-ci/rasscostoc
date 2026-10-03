import type { ReactNode } from "react";

/** Telegram link facts as returned by GET /api/users (all come from the backend). */
export type TelegramLinkFields = {
  telegramUserId?: string | null;
  telegramUsername?: string | null;
  telegramLinked?: boolean | null;
  telegramLinkedAt?: string | Date | null;
  telegramLastSeenAt?: string | Date | null;
};

const fmt = (value: string | Date | null | undefined): string | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("ar-SA", { dateStyle: "medium", timeStyle: "short" });
};

function Row({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3" data-testid={testId}>
      <span className="text-slate-400">{label}</span>
      <span className="font-semibold text-slate-700 dark:text-slate-300 text-left">{children}</span>
    </div>
  );
}

/**
 * Shown for a user the bot has linked (or an admin has linked by hand). Dates the system never recorded
 * (accounts an admin linked before the self-link existed) read "غير مسجل" — never a guessed date.
 */
export function TelegramLinkStatus({ user }: { user: TelegramLinkFields }) {
  const linked = user.telegramLinked ?? !!user.telegramUserId;
  if (!linked || !user.telegramUserId) return null;
  const notRecorded = "غير مسجل";
  return (
    <div className="space-y-1 text-xs text-right pt-2" data-testid="telegram-link-status">
      <Row label="حالة الربط" testId="tg-status">
        <span className="text-emerald-600 dark:text-emerald-400">مربوط ✓</span>
      </Row>
      <Row label="Telegram ID" testId="tg-id">
        <span className="font-mono" dir="ltr">{user.telegramUserId}</span>
      </Row>
      <Row label="Telegram Username" testId="tg-username">
        {user.telegramUsername ? <span dir="ltr">@{user.telegramUsername.replace(/^@/, "")}</span> : notRecorded}
      </Row>
      <Row label="تاريخ الربط" testId="tg-linked-at">{fmt(user.telegramLinkedAt) ?? notRecorded}</Row>
      <Row label="آخر دخول عبر Telegram" testId="tg-last-seen">{fmt(user.telegramLastSeenAt) ?? "لم يستخدم البوت بعد"}</Row>
    </div>
  );
}
