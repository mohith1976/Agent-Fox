import type { DMChannel, TextChannel } from 'discord.js';

/**
 * Discord adapter types — thin wrappers over discord.js payloads.
 * No `any`: everything the listener touches is typed.
 */

/** A DM channel we can send (and type in) to. */
export type DiscordReplyChannel = TextChannel | DMChannel;

/** Normalized inbound user message (after partial fetch + filtering). */
export interface DiscordIncomingText {
  /** Discord message ID — requestId (unique per message). */
  messageId: string;
  /** Author ID — threadId basis (stable per user). */
  authorId: string;
  /** Display name — logging only, never identity. */
  username: string;
  /** Trimmed message text (non-empty — empties never reach here). */
  content: string;
}

/** Outcome of one processed message (logging/telemetry). */
export interface DiscordProcessResult {
  action: 'replied' | 'ignored' | 'failed';
  requestId: string;
}
