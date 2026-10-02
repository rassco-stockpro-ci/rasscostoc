export const PLATFORM_LOCK_MODES = [
  "ACTIVE",
  "MAINTENANCE",
  "SUBSCRIPTION_SUSPENDED",
  "SECURITY_LOCKDOWN",
] as const;

export type PlatformLockMode = (typeof PLATFORM_LOCK_MODES)[number];

export type PlatformLockState = {
  id: string;
  mode: PlatformLockMode;
  publicMessage: string | null;
  internalReason: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  subscriptionExpiresAt: string | null;
  gracePeriodEndsAt: string | null;
  stopWorkers: boolean;
  revokeSessions: boolean;
  systemLockVersion: number;
  suspendedAt: string | null;
  reactivatedAt: string | null;
  suspensionReason: string | null;
  updatedAt: string | null;
  source: "database" | "failsafe-file" | "fail-closed-default";
};

export const DEFAULT_PUBLIC_MESSAGES: Record<PlatformLockMode, string> = {
  ACTIVE: "",
  MAINTENANCE: "النظام متوقف مؤقتًا للصيانة. يرجى التواصل مع مزود الخدمة.",
  SUBSCRIPTION_SUSPENDED:
    "تم تعليق النظام بسبب انتهاء الاشتراك. يرجى التواصل مع مزود الخدمة.",
  SECURITY_LOCKDOWN:
    "النظام مقفل لأسباب أمنية. يرجى التواصل مع مزود الخدمة.",
};

export function isPlatformLockMode(value: unknown): value is PlatformLockMode {
  return typeof value === "string" && (PLATFORM_LOCK_MODES as readonly string[]).includes(value);
}
