import type { Express, Request, Response } from "express";
import { requireAuth, requireAdmin } from "@core/middlewares/auth.middleware";
import { pool } from "@core/config/db";
import { logger } from "@server/utils/logger";

interface DiscoveryLogEntry {
  id: string;
  userId: string;
  userName: string;
  userRole: string;
  apiKey: string;
  maskedKey: string;
  searchMode: string;
  regionName: string;
  leadsFound: number;
  newLeadsCount: number;
  createdAt: string;
}

// In-memory fallback log buffer in case database table isn't migrated yet
let inMemoryLogs: DiscoveryLogEntry[] = [];
// Set of blocked user names or IDs for lead discovery access control
const blockedUserIdentifiers = new Set<string>();

function maskKey(key?: string): string {
  if (!key || key.length < 8) return "AIza...****";
  return `${key.substring(0, 6)}...${key.substring(key.length - 4)}`;
}

export function registerLeadDiscoveryAuditRoutes(app: Express): void {
  /**
   * GET /api/leads/discovery/check-access
   * Checks if current user/account is allowed to perform lead discovery with API key.
   */
  app.get("/api/leads/discovery/check-access", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user || {};
    const userId = String(user.id || user.userId || "");
    const userName = String(user.username || user.name || "");

    const isBlocked = blockedUserIdentifiers.has(userId) || blockedUserIdentifiers.has(userName);

    if (isBlocked) {
      return res.status(403).json({
        allowed: false,
        error: "DISCOVERY_BLOCKED",
        message: "تم إيقاف صلاحية سحب العملاء واستهلاك المفتاح لهذا الحساب بواسطة الإدارة",
      });
    }

    return res.json({ allowed: true });
  });

  /**
   * POST /api/leads/discovery/log
   * Records a lead discovery / Google Places API scraping action from a mobile device or web client.
   */
  app.post("/api/leads/discovery/log", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user || {};
      const userId = user.id || user.userId || "anonymous";
      const userName = user.username || user.name || "فني ميداني";
      const userRole = user.role || "technician";

      // Access control check
      if (blockedUserIdentifiers.has(String(userId)) || blockedUserIdentifiers.has(String(userName))) {
        return res.status(403).json({
          allowed: false,
          error: "DISCOVERY_BLOCKED",
          message: "تم إيقاف صلاحية سحب العملاء واستهلاك المفتاح لهذا الحساب بواسطة الإدارة",
        });
      }

      const { apiKey, searchMode, regionName, leadsFound, newLeadsCount, details } = req.body || {};
      const actualKey = typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : "Default Server Key";
      const masked = maskKey(actualKey);
      const mode = typeof searchMode === "string" ? searchMode : "CURRENT_LOCATION";
      const region = typeof regionName === "string" ? regionName : "موقع GPS حقيقي";
      const foundCount = typeof leadsFound === "number" ? leadsFound : 0;
      const newCount = typeof newLeadsCount === "number" ? newLeadsCount : 0;

      const logId = `disc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const entry: DiscoveryLogEntry = {
        id: logId,
        userId: String(userId),
        userName: String(userName),
        userRole: String(userRole),
        apiKey: actualKey,
        maskedKey: masked,
        searchMode: mode,
        regionName: region,
        leadsFound: foundCount,
        newLeadsCount: newCount,
        createdAt: new Date().toISOString(),
      };

      inMemoryLogs.unshift(entry);
      if (inMemoryLogs.length > 500) {
        inMemoryLogs.pop();
      }

      // Try inserting into PostgreSQL system_logs table for persistent audit
      try {
        await pool.query(
          `INSERT INTO system_logs (user_id, user_name, user_role, action, entity_type, entity_id, entity_name, details, description, severity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            userId,
            userName,
            userRole,
            "SCRAPE_LEADS",
            "LEAD_DISCOVERY",
            logId,
            region,
            JSON.stringify({ apiKey: masked, searchMode: mode, leadsFound: foundCount, newLeadsCount: newCount, details }),
            `قام ${userName} بعملية سحب عملاء (${foundCount} عميل) باستخدام المفتاح ${masked}`,
            "info",
          ]
        );
      } catch (dbErr) {
        logger.warn("Could not insert lead discovery log into DB system_logs, kept in memory fallback", { error: dbErr });
      }

      logger.info(`Lead Discovery Logged: User ${userName} scraped ${foundCount} leads via ${masked}`);

      return res.status(201).json({
        success: true,
        message: "تم تسجيل عملية سحب العملاء بنجاح",
        logId,
      });
    } catch (error: any) {
      logger.error("Error logging lead discovery:", error);
      return res.status(500).json({ error: "فشل تسجيل بيانات السحب" });
    }
  });

  /**
   * POST /api/leads/discovery/toggle-user-access
   * Admin Endpoint: Enables or blocks a user account from performing lead discovery / API scraping.
   *
   * OPS-SEC-HOTFIX-LEADS-AUDIT-ADMIN-AUTHORIZATION: this mutates another
   * account's access and MUST be Admin-only. requireAdmin uses the
   * canonical role check (req.user.role === ROLES.ADMIN via
   * @core/middlewares/auth.middleware), never the legacy users.permissions
   * authority.
   */
  app.post("/api/leads/discovery/toggle-user-access", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { userName, userId, allow } = req.body || {};
      const target = String(userName || userId || "").trim();

      if (!target) {
        return res.status(400).json({ error: "يجب تحديد اسم أو معرف حساب الفني" });
      }

      if (allow === true) {
        blockedUserIdentifiers.delete(target);
        if (userId) blockedUserIdentifiers.delete(String(userId));
        logger.info(`Lead discovery access ALLOWED for account: ${target}`);
      } else {
        blockedUserIdentifiers.add(target);
        if (userId) blockedUserIdentifiers.add(String(userId));
        logger.info(`Lead discovery access BLOCKED for account: ${target}`);
      }

      return res.json({
        success: true,
        userName: target,
        isBlocked: !allow,
        message: allow
          ? `تم تفعيل صلاحية السحب للحساب (${target}) بنجاح`
          : `تم إغلاق وحظر صلاحية السحب واستخدام المفتاح للحساب (${target}) بنجاح`,
      });
    } catch (error: any) {
      logger.error("Error toggling user discovery access:", error);
      return res.status(500).json({ error: "فشل تحديث حالة الصلاحية" });
    }
  });

  /**
   * POST /api/leads/discovery/clear-user-leads
   * Admin Endpoint: Deletes all lead discovery activity logs and scraped data associated with a specific user.
   *
   * OPS-SEC-HOTFIX-LEADS-AUDIT-ADMIN-AUTHORIZATION: this deletes another
   * account's audit/lead data (in-memory and system_logs DB rows) and MUST
   * be Admin-only. requireAdmin uses the canonical role check
   * (req.user.role === ROLES.ADMIN via @core/middlewares/auth.middleware),
   * never the legacy users.permissions authority.
   */
  app.post("/api/leads/discovery/clear-user-leads", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { userName, userId } = req.body || {};
      const targetName = String(userName || "").trim();
      const targetId = String(userId || "").trim();

      if (!targetName && !targetId) {
        return res.status(400).json({ error: "يجب تحديد اسم أو معرف الحساب المطلوب حذف سحبياته" });
      }

      // Filter out in-memory logs
      const beforeCount = inMemoryLogs.length;
      inMemoryLogs = inMemoryLogs.filter(
        (l) => l.userName !== targetName && l.userId !== targetId
      );
      const deletedInMemoryCount = beforeCount - inMemoryLogs.length;

      let dbDeletedCount = 0;
      // Delete from PostgreSQL system_logs database table
      try {
        const dbRes = await pool.query(
          `DELETE FROM system_logs 
           WHERE entity_type = 'LEAD_DISCOVERY' 
             AND (user_name = $1 OR user_id = $2)`,
          [targetName, targetId]
        );
        dbDeletedCount = dbRes.rowCount || 0;
      } catch (dbErr) {
        logger.warn("DB deletion for user lead discovery logs failed:", { error: dbErr });
      }

      logger.info(`Lead discovery logs CLEARED for user: ${targetName || targetId}`);

      return res.json({
        success: true,
        message: `تم حذف جميع سجلات والعملاء المسحوبين للحساب (${targetName || targetId}) بنجاح`,
        deletedLogsCount: dbDeletedCount + deletedInMemoryCount,
      });
    } catch (error: any) {
      logger.error("Error clearing user discovery leads:", error);
      return res.status(500).json({ error: "فشل حذف العملاء المسحوبين للحساب" });
    }
  });

  /**
   * GET /api/leads/discovery/audit-summary
   * Returns analytical audit stats regarding which users used API keys to fetch leads.
   */
  app.get("/api/leads/discovery/audit-summary", requireAuth, async (_req: Request, res: Response) => {
    try {
      let logs: DiscoveryLogEntry[] = [...inMemoryLogs];

      // Try fetching system_logs from DB for LEAD_DISCOVERY
      try {
        const dbResult = await pool.query(
          `SELECT id, user_id as "userId", user_name as "userName", user_role as "userRole", 
                  entity_name as "regionName", details, created_at as "createdAt"
           FROM system_logs 
           WHERE entity_type = 'LEAD_DISCOVERY' AND action = 'SCRAPE_LEADS'
           ORDER BY created_at DESC 
           LIMIT 300`
        );

        if (dbResult.rows.length > 0) {
          const dbLogs: DiscoveryLogEntry[] = dbResult.rows.map((row: any) => {
            let parsedDetails: any = {};
            try {
              parsedDetails = typeof row.details === "string" ? JSON.parse(row.details) : row.details || {};
            } catch (_) {}

            const maskedKey = parsedDetails.apiKey || "AIza...****";
            return {
              id: row.id,
              userId: row.userId || "anonymous",
              userName: row.userName || "فني ميداني",
              userRole: row.userRole || "technician",
              apiKey: maskedKey,
              maskedKey: maskedKey,
              searchMode: parsedDetails.searchMode || "CURRENT_LOCATION",
              regionName: row.regionName || "المنطقة الحالية",
              leadsFound: parsedDetails.leadsFound || 0,
              newLeadsCount: parsedDetails.newLeadsCount || 0,
              createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
            };
          });

          // Merge DB logs with in-memory logs (dedup by id)
          const map = new Map<string, DiscoveryLogEntry>();
          for (const l of [...dbLogs, ...inMemoryLogs]) {
            map.set(l.id, l);
          }
          logs = Array.from(map.values()).sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        }
      } catch (dbErr) {
        logger.warn("DB query for lead discovery logs failed, using in-memory fallback:", { error: dbErr });
      }

      // Aggregate statistics by user
      const userMap = new Map<string, {
        userId: string;
        userName: string;
        userRole: string;
        scrapesCount: number;
        leadsFetched: number;
        newLeadsFetched: number;
        lastScrapeAt: string;
        apiKeysUsed: Set<string>;
        isBlocked: boolean;
      }>();

      // Aggregate statistics by API Key
      const keyMap = new Map<string, {
        maskedKey: string;
        scrapesCount: number;
        leadsFetched: number;
        users: Set<string>;
      }>();

      let totalScrapes = logs.length;
      let totalLeadsFetched = 0;
      let totalNewLeads = 0;

      for (const log of logs) {
        totalLeadsFetched += log.leadsFound;
        totalNewLeads += log.newLeadsCount;

        const isUserBlocked = blockedUserIdentifiers.has(log.userName) || blockedUserIdentifiers.has(log.userId);

        // User Aggregation
        const existingUser = userMap.get(log.userName) || {
          userId: log.userId,
          userName: log.userName,
          userRole: log.userRole,
          scrapesCount: 0,
          leadsFetched: 0,
          newLeadsFetched: 0,
          lastScrapeAt: log.createdAt,
          apiKeysUsed: new Set<string>(),
          isBlocked: isUserBlocked,
        };

        existingUser.scrapesCount += 1;
        existingUser.leadsFetched += log.leadsFound;
        existingUser.newLeadsFetched += log.newLeadsCount;
        existingUser.apiKeysUsed.add(log.maskedKey);
        existingUser.isBlocked = isUserBlocked;
        if (new Date(log.createdAt).getTime() > new Date(existingUser.lastScrapeAt).getTime()) {
          existingUser.lastScrapeAt = log.createdAt;
        }
        userMap.set(log.userName, existingUser);

        // API Key Aggregation
        const keyKey = log.maskedKey;
        const existingKey = keyMap.get(keyKey) || {
          maskedKey: keyKey,
          scrapesCount: 0,
          leadsFetched: 0,
          users: new Set<string>(),
        };
        existingKey.scrapesCount += 1;
        existingKey.leadsFetched += log.leadsFound;
        existingKey.users.add(log.userName);
        keyMap.set(keyKey, existingKey);
      }

      const userSummaries = Array.from(userMap.values()).map(u => ({
        ...u,
        apiKeysUsed: Array.from(u.apiKeysUsed),
      })).sort((a, b) => b.leadsFetched - a.leadsFetched);

      const apiKeysSummary = Array.from(keyMap.values()).map(k => ({
        ...k,
        users: Array.from(k.users),
      })).sort((a, b) => b.leadsFetched - a.leadsFetched);

      return res.json({
        totalScrapes,
        totalLeadsFetched,
        totalNewLeads,
        userSummaries,
        apiKeysSummary,
        blockedUserCount: blockedUserIdentifiers.size,
        recentLogs: logs.slice(0, 100),
      });
    } catch (error: any) {
      logger.error("Error retrieving lead discovery audit summary:", error);
      return res.status(500).json({ error: "فشل جلب سجلات تتبع سحب العملاء" });
    }
  });
}
