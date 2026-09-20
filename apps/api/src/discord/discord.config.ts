import { Injectable, Logger } from '@nestjs/common';

/**
 * DiscordConfig — single source of truth for Discord env vars.
 *
 * Warn-only on missing values: an absent token must NEVER crash boot
 * (React/API run regardless; the module simply stays inert).
 */
@Injectable()
export class DiscordConfig {
  private readonly logger = new Logger(DiscordConfig.name);

  /** Bot token from Developer Portal → Bot → Reset Token. */
  readonly botToken: string = process.env.DISCORD_BOT_TOKEN || '';

  /** Discord user IDs allowed to talk to the bot (comma-separated). */
  readonly allowedUserIds: string[] = (
    process.env.DISCORD_ALLOWED_USER_IDS || ''
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  /** True when the gateway client may log in. */
  get isConfigured(): boolean {
    return this.botToken !== '';
  }

  /** Fail-visible startup report (values never logged). */
  reportStatus(): void {
    if (!this.isConfigured) {
      this.logger.warn(
        'Discord NOT configured (DISCORD_BOT_TOKEN missing). ' +
          'Module stays inert. React/API unaffected.',
      );
      return;
    }
    this.logger.log(
      `Discord configured (allowlist: ${this.allowedUserIds.length} user(s)).`,
    );
    if (this.allowedUserIds.length === 0) {
      this.logger.warn(
        'DISCORD_ALLOWED_USER_IDS is empty — the bot will ignore EVERYONE (fail-closed). Add your Discord user ID.',
      );
    }
  }
}
