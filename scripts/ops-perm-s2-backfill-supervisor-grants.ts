/**
 * OPS-PERM-S2 — one-time backfill: grant every existing supervisor the
 * ceiling-only permissions (those in ROLE_HARD_CEILING.supervisor but NOT in
 * DEFAULT_ROLE_TEMPLATE.supervisor) as explicit overrides.
 *
 * Why this has to run before enforcing those actions: DEFAULT_ROLE_TEMPLATE
 * is what every supervisor gets with zero admin action. The catalog's
 * ceiling-only actions (courier.requests:create, warehouse.transfers:approve,
 * warehouse.transfers:transfer, reports.operational:view) were never actually
 * enforced anywhere in production — the Permission Engine existed but no real
 * route ever called it (OPS-PERM-S2 finding). If we flip on real enforcement
 * for those actions without this backfill, every existing supervisor account
 * would silently lose whatever access it has today, with no explicit grant
 * to fall back on. Running this first makes that rollout a true no-op for
 * every account that exists at run time.
 *
 * Idempotent — reruns safely. Uses PermissionsService.grantPermission()
 * itself (not a raw INSERT) so every backfilled grant gets the exact same
 * validation and audit-trail row a real admin action would.
 *
 * Note: courier.requests:create is included for completeness even though
 * CourierService.createRequest currently blocks every non-admin role
 * unconditionally at the service layer — see the OPS-PERM-S2 report's
 * "catalog/business-logic mismatch" finding. Backfilling it is inert today
 * (nothing enforces it, and even if something did, the service layer's own
 * check would still block it) but keeps the override state consistent with
 * the full ceiling in case that business rule ever changes.
 */
import "dotenv/config";
import { db, pool } from "../apps/api/src/core/config/db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { permissionsContainer } from "../apps/api/src/composition/permissions.container";
import { ROLE_HARD_CEILING, DEFAULT_ROLE_TEMPLATE, permissionKeyString } from "../apps/api/src/modules/permissions/domain/permission-catalog";

const REASON = "OPS-PERM-S2 backfill: preserve existing default access before enabling backend enforcement";

function backfillTargets(): Array<{ page: string; action: string }> {
  const ceilingKeys = ROLE_HARD_CEILING.supervisor.grants;
  const templateKeys = DEFAULT_ROLE_TEMPLATE.supervisor;
  const targets: Array<{ page: string; action: string }> = [];
  for (const key of ceilingKeys) {
    if (templateKeys.has(key)) continue;
    const [page, action] = key.split(":");
    targets.push({ page, action });
  }
  return targets;
}

async function main(): Promise<void> {
  const targets = backfillTargets();
  console.log(`Backfill targets (ceiling minus default template): ${targets.map((t) => permissionKeyString(t.page, t.action)).join(", ")}`);

  const [actingAdmin] = await db.select().from(users).where(eq(users.role, "admin")).limit(1);
  if (!actingAdmin) {
    console.error("No admin user found — cannot backfill (grantPermission requires a real acting admin actor).");
    process.exit(1);
  }
  console.log(`Acting as admin: ${actingAdmin.username} (${actingAdmin.id})`);

  const supervisors = await db.select().from(users).where(eq(users.role, "supervisor"));
  console.log(`Found ${supervisors.length} supervisor account(s).`);

  let granted = 0;
  let alreadyGranted = 0;
  let failed = 0;

  for (const supervisor of supervisors) {
    for (const { page, action } of targets) {
      try {
        const result = await permissionsContainer.service.grantPermission(actingAdmin.id, supervisor.id, page, action, REASON);
        if (result?.version === 1) {
          granted++;
        } else {
          alreadyGranted++;
        }
      } catch (error) {
        failed++;
        console.error(`Failed to grant ${permissionKeyString(page, action)} to ${supervisor.username} (${supervisor.id}):`, error instanceof Error ? error.message : error);
      }
    }
  }

  console.log(`Done. New grants: ${granted}. Already granted (no-op): ${alreadyGranted}. Failed: ${failed}.`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
