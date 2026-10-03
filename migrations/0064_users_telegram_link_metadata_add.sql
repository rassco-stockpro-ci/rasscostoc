-- Telegram self-link: who linked which Telegram account, when, and when the account was last used through the bot.
--
-- users.telegram_user_id (0025) already exists and is UNIQUE, so one Telegram account can never map to
-- two users. The bot's self-link flow (POST /api/telegram/link) additionally records the Telegram
-- @username seen at link time and the link timestamp, for audit and for support ("which Telegram account is
-- this technician using, since when?").
--
-- Additive and nullable: no default, no backfill (accounts linked by an admin before this migration keep
-- NULL here — their link date is unknown and is not invented).
--
-- Rollback:
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "telegram_last_seen_at";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "telegram_linked_at";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "telegram_username";
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegram_username" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegram_linked_at" timestamp;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegram_last_seen_at" timestamp;
