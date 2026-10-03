import type { Express } from "express";
import { registerAuthRoutes } from "./auth.routes";
import { registerAdminRoutes } from "./admin.routes";
import { registerUsersRoutes } from "./users.routes";
import { registerTelegramLinkRoutes } from "./telegram-link.routes";

export function registerIdentityRoutes(app: Express): void {
  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerUsersRoutes(app);
  registerTelegramLinkRoutes(app);
}
