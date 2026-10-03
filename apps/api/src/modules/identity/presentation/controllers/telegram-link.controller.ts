/**
 * POST /api/telegram/link — called by the installation bot (internal service key only).
 * The request body carries a password: it is parsed here, handed to the use case, and never logged or echoed.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { linkTelegramAccountUseCase } from "@server/composition/telegram-link.container";
import { asyncHandler } from "@core/errors/errorHandler";

const linkBodySchema = z
  .object({
    // Telegram user ids are numeric.
    telegramUserId: z.string().trim().regex(/^\d{5,20}$/, "telegramUserId must be the numeric Telegram user id"),
    telegramUsername: z
      .string()
      .trim()
      .regex(/^@?[A-Za-z0-9_]{1,64}$/, "invalid telegramUsername")
      .nullish(),
    username: z.string().trim().min(1, "username required").max(100),
    // bcrypt only looks at the first 72 bytes; refuse absurd sizes instead of hashing them.
    password: z.string().min(1, "password required").max(200),
  })
  .strict();

export class TelegramLinkController {
  link = asyncHandler(async (req: Request, res: Response) => {
    const input = linkBodySchema.parse(req.body);
    const result = await linkTelegramAccountUseCase.execute(input);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, ...result });
  });
}

export const telegramLinkController = new TelegramLinkController();
