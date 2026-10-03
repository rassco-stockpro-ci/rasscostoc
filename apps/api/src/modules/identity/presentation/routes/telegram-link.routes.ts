import type { Express } from "express";
import { requireInternalService } from "@core/middlewares/auth.middleware";
import { telegramLinkController } from "../controllers/telegram-link.controller";

export function registerTelegramLinkRoutes(app: Express): void {
  // Internal service key only (the installation bot). No user session, no x-telegram-user-id: the caller is not linked yet.
  app.post("/api/telegram/link", requireInternalService, telegramLinkController.link);
}
