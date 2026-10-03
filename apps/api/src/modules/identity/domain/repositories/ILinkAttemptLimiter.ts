/** Counts credential attempts per key inside a time window (shared by every process). */
export interface ILinkAttemptLimiter {
  /** Atomically records one attempt and returns how many were made in the current window. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
  /** Forgets the key (after a successful link). */
  clear(key: string): Promise<void>;
}
