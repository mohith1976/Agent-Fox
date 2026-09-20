import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { DiscordConfig } from './discord.config';
import type { DiscordReplyChannel } from './discord.types';

/**
 * DiscordService — owns the discord.js gateway Client and all OUTBOUND sends.
 *
 * DM-mode intents + partials (Partials.Channel is REQUIRED — without it,
 * discord.js silently drops DM events; Guild intents intentionally absent).
 * Login happens only when configured; otherwise the module stays inert and
 * boot proceeds (React/API never depend on this).
 *
 * Production behaviors:
 * - 2000-char ceiling: chunked on newline boundaries (never mid-word),
 *   sent sequentially in order.
 * - PNG answers go as real attachments (AttachmentBuilder).
 * - Disconnect/error visibility via gateway event logging (discord.js
 *   auto-resumes sessions itself).
 * - Typing indicator helper for long AI turns (Discord expires it ~10s;
 *   callers re-send on an interval).
 */

const MAX_DISCORD_CHUNK = 1900;

@Injectable()
export class DiscordService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiscordService.name);
  private client: Client | null = null;

  constructor(private readonly config: DiscordConfig) {}

  async onModuleInit(): Promise<void> {
    this.config.reportStatus();
    if (!this.config.isConfigured) {
      return;
    }
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.once(Events.ClientReady, (ready) => {
      this.logger.log(`Discord gateway ready as ${ready.user.tag}`);
    });
    this.client.on(Events.Error, (error) => {
      this.logger.warn(
        `Discord gateway error: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    try {
      await this.client.login(this.config.botToken);
    } catch (error) {
      // Bad/expired token must not kill the backend — stay inert, loudly.
      this.logger.error(
        `Discord login failed (check DISCORD_BOT_TOKEN): ${error instanceof Error ? error.message : String(error)}. Module inert; React/API unaffected.`,
      );
      try {
        await this.client.destroy();
      } catch {
        // Best effort only.
      }
      this.client = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {
        // Best effort only.
      }
      this.client = null;
    }
  }

  /** Null when unconfigured or login failed — callers must no-op. */
  getClient(): Client | null {
    return this.client;
  }

  /**
   * Send AI reply text (chunked, in order). Resolves when all chunks send.
   */
  async sendMessage(
    channel: DiscordReplyChannel,
    text: string,
  ): Promise<void> {
    const chunks = splitIntoChunks(formatForDiscord(text));
    for (let i = 0; i < chunks.length; i++) {
      await channel.send(chunks[i]);
      this.logger.log(
        `Discord text chunk ${i + 1}/${chunks.length} sent`,
      );
    }
  }

  /**
   * Send a chart PNG as a real attachment with an optional caption.
   */
  async sendImageAttachment(
    channel: DiscordReplyChannel,
    png: Buffer,
    filename = 'chart.png',
    caption?: string,
  ): Promise<void> {
    const attachment = new AttachmentBuilder(png, { name: filename });
    if (caption) {
      await channel.send({ content: caption, files: [attachment] });
      return;
    }
    await channel.send({ files: [attachment] });
    this.logger.log('Discord image attachment sent');
  }

  /**
   * Send the workbook file itself (download command). Same bytes the React
   * download button serves — reuse, never reimplement.
   */
  async sendWorkbookFile(
    channel: DiscordReplyChannel,
    workbook: Buffer,
    filename = 'Budget_2026.xlsx',
  ): Promise<void> {
    const attachment = new AttachmentBuilder(workbook, { name: filename });
    await channel.send({
      content: 'Here is the current workbook, as recorded.',
      files: [attachment],
    });
    this.logger.log(
      `Discord workbook file sent (${workbook.length} bytes)`,
    );
  }

  /**
   * Send the command center: a select-menu dropdown (options, not buttons —
   * buttons would look worse for a command list). Each option dispatches to
   * the same handler as its typed words.
   */
  async sendCommandMenu(channel: DiscordReplyChannel): Promise<void> {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('agentfox:menu')
      .setPlaceholder('Choose a command…')
      .addOptions(
        {
          label: 'Download workbook',
          description: 'Get the current Budget file',
          value: 'menu:download',
          emoji: '📥',
        },
        {
          label: 'Upload workbook',
          description: 'Replace it with a file you post',
          value: 'menu:upload',
          emoji: '📤',
        },
        {
          label: 'Start a transaction',
          description: 'How to log spending',
          value: 'menu:log',
          emoji: '💳',
        },
        {
          label: 'Ask a query',
          description: 'How to ask about money',
          value: 'menu:ask',
          emoji: '📊',
        },
        {
          label: 'New chat',
          description: 'Start fresh, leave this one behind',
          value: 'menu:newchat',
          emoji: '🔄',
        },
      );
    const row =
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    await channel.send({
      content: 'What would you like to do?',
      components: [row],
    });
    this.logger.log('Discord command menu sent');
  }

  /**
   * Send the transaction review as a rich embed card with Confirm/Cancel
   * buttons — the Discord dress for React's review card. Layout rules: bold
   * "N. description" headers (plain "#" has no meaning in Discord and
   * prints literally), one airy detail line per item, blank line between
   * items, short footer (footer text renders tiny — never put instructions
   * there). Descriptions are scrubbed of markdown metacharacters so user
   * words can't break the card's own formatting.
   */
  async sendReviewCard(
    channel: DiscordReplyChannel,
    items: Array<{
      description?: string;
      amount?: number;
      mode?: string;
      direction?: string;
      suggestedCategory?: string | null;
      colourCategory?: string | null;
      category?: string | null;
    }>,
  ): Promise<void> {
    const blocks = items.slice(0, 25).map((tx, i) => {
      const desc = String(tx.description || '(no description)').replace(
        /[*`~_>]/g,
        '',
      );
      const cat =
        tx.colourCategory || tx.suggestedCategory || tx.category || 'UNCATEGORIZED';
      return (
        `**${i + 1}. ${desc}**\n` +
        `₹${Number(tx.amount ?? 0).toLocaleString('en-IN')} • ${String(tx.mode || '?')} • ${String(tx.direction || 'DEBIT')} • ${cat}`
      );
    });
    const embed = new EmbedBuilder()
      .setTitle('📋 Transaction Review')
      .setDescription(
        'Please review before saving.\n' +
          'Edit anytime, e.g. "change item 1 category to personal".\n\n' +
          blocks.join('\n\n'),
      )
      .setFooter({
        text: 'Review the items, then Confirm & Save or Cancel below.',
      })
      .setColor(0x2563eb);
    const row =
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('agentfox:confirm')
          .setLabel('✓ Confirm & Save')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('agentfox:cancel')
          .setLabel('× Cancel')
          .setStyle(ButtonStyle.Secondary),
      );
    await channel.send({ embeds: [embed], components: [row] });
    this.logger.log(`Discord review card sent (${blocks.length} item(s))`);
  }

  /**
   * Best-effort typing indicator (expires server-side after ~10s).
   */
  async sendTyping(channel: DiscordReplyChannel): Promise<void> {
    try {
      await channel.sendTyping();
    } catch {
      // Cosmetic only — never fail a turn over typing state.
    }
  }
}

/**
 * Split long text into ordered chunks on newline boundaries (word, then
 * char fallback for pathological single lines), each within the ceiling.
 */
export function splitIntoChunks(
  text: string,
  ceiling: number = MAX_DISCORD_CHUNK,
): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= ceiling) {
    return [normalized];
  }
  const chunks: string[] = [];
  let current = '';
  const push = (): void => {
    if (current.trim() !== '') {
      chunks.push(current.trim());
    }
    current = '';
  };
  for (const line of normalized.split('\n')) {
    const candidate = current === '' ? line : current + '\n' + line;
    if (candidate.length <= ceiling) {
      current = candidate;
      continue;
    }
    if (current !== '') {
      push();
    }
    let rest = line;
    while (rest.length > ceiling) {
      let cut = rest.lastIndexOf(' ', ceiling);
      if (cut <= 0) {
        cut = ceiling;
      }
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    current = rest;
  }
  push();
  return chunks.length > 0 ? chunks : [normalized];
}

/**
 * Light plain-text shaping. Discord renders **bold** and - bullets natively
 * (unlike WhatsApp), so nothing is stripped — only 3+ blank lines collapse
 * and surrounding whitespace trims. Figures and ₹ pass through.
 */
export function formatForDiscord(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
