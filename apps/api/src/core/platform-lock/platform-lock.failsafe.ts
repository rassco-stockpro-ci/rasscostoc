import fs from "fs";
import path from "path";
import type { PlatformLockState } from "./platform-lock.types";
import { isPlatformLockMode } from "./platform-lock.types";

export function resolvePlatformLockFailsafePath(): string {
  const fromEnv = process.env.PLATFORM_LOCK_STATE_FILE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "data", "platform-lock.json");
}

export function readFailsafeLockState(): PlatformLockState | null {
  try {
    const filePath = resolvePlatformLockFailsafePath();
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PlatformLockState>;
    if (!isPlatformLockMode(raw.mode)) return null;
    return {
      id: raw.id || "default",
      mode: raw.mode,
      publicMessage: raw.publicMessage ?? null,
      internalReason: raw.internalReason ?? null,
      lockedAt: raw.lockedAt ?? null,
      lockedBy: raw.lockedBy ?? null,
      subscriptionExpiresAt: raw.subscriptionExpiresAt ?? null,
      gracePeriodEndsAt: raw.gracePeriodEndsAt ?? null,
      stopWorkers: raw.stopWorkers !== false,
      revokeSessions: raw.revokeSessions !== false,
      systemLockVersion: Number(raw.systemLockVersion || 0),
      suspendedAt: raw.suspendedAt ?? null,
      reactivatedAt: raw.reactivatedAt ?? null,
      suspensionReason: raw.suspensionReason ?? null,
      updatedAt: raw.updatedAt ?? null,
      source: "failsafe-file",
    };
  } catch {
    return null;
  }
}

export function writeFailsafeLockState(state: PlatformLockState): void {
  const filePath = resolvePlatformLockFailsafePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = { ...state, source: "failsafe-file" as const };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}
