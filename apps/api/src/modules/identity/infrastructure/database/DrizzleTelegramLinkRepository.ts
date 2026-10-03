import { and, eq, inArray, ne } from "drizzle-orm";
import { getDatabase } from "@core/database/connection";
import { systemLogs, users } from "@shared/schema";
import type { IdentityAuditEntry } from "../../domain/repositories/IIdentityUnitOfWork";
import type {
  ITelegramLinkRepository,
  TelegramLinkOutcome,
  TelegramLinkRequest,
} from "../../domain/repositories/ITelegramLinkRepository";

const UNIQUE_VIOLATION = "23505";
const errorCode = (err: unknown): string | undefined =>
  (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;

const auditRow = (entry: IdentityAuditEntry) => ({
  userId: entry.userId,
  userName: entry.userName,
  userRole: entry.userRole,
  regionId: null,
  action: entry.action,
  entityType: entry.entityType,
  entityId: entry.entityId,
  entityName: entry.entityName,
  description: entry.description,
  severity: entry.severity,
  success: entry.success,
});

export class DrizzleTelegramLinkRepository implements ITelegramLinkRepository {
  async link(request: TelegramLinkRequest): Promise<TelegramLinkOutcome> {
    const db = getDatabase();
    try {
      return await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: users.id, isActive: users.isActive, role: users.role, telegramUserId: users.telegramUserId })
          .from(users)
          .where(eq(users.id, request.userId))
          .for("update");

        if (!row) return "USER_NOT_FOUND";
        if (!row.isActive) return "ACCOUNT_INACTIVE";
        if (row.role !== request.allowedRole) return "ROLE_NOT_ALLOWED";

        if (row.telegramUserId) {
          return row.telegramUserId.replace(/^@/, "") === request.telegramUserId ? "ALREADY_LINKED_SAME" : "ACCOUNT_LINKED_TO_OTHER";
        }

        const [other] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.telegramUserId, [request.telegramUserId, `@${request.telegramUserId}`]), ne(users.id, request.userId)))
          .limit(1);
        if (other) return "TELEGRAM_ID_TAKEN";

        await tx
          .update(users)
          .set({
            telegramUserId: request.telegramUserId,
            telegramUsername: request.telegramUsername,
            telegramLinkedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, request.userId));
        await tx.insert(systemLogs).values(auditRow(request.successAudit));
        return "LINKED";
      });
    } catch (err) {
      // Two different users racing for the same Telegram id: the UNIQUE constraint is the last word.
      if (errorCode(err) === UNIQUE_VIOLATION) return "TELEGRAM_ID_TAKEN";
      throw err;
    }
  }

  async recordFailure(entry: IdentityAuditEntry): Promise<void> {
    await getDatabase().insert(systemLogs).values(auditRow(entry));
  }
}
