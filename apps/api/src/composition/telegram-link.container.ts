import { LinkTelegramAccountUseCase } from "@modules/identity/application/telegram/LinkTelegramAccount.use-case";
import { UserRepository } from "@modules/identity/infrastructure/database/UserRepository";
import { DrizzleTelegramLinkRepository } from "@modules/identity/infrastructure/database/DrizzleTelegramLinkRepository";
import { DrizzleLinkAttemptLimiter } from "@modules/identity/infrastructure/database/DrizzleLinkAttemptLimiter";

class TelegramLinkContainer {
  readonly linkTelegramAccount = new LinkTelegramAccountUseCase(
    new UserRepository(),
    new DrizzleTelegramLinkRepository(),
    new DrizzleLinkAttemptLimiter()
  );
}

export const telegramLinkContainer = new TelegramLinkContainer();
export const linkTelegramAccountUseCase = telegramLinkContainer.linkTelegramAccount;
