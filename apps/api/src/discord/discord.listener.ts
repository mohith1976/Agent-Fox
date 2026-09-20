import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ButtonInteraction,
  ChannelType,
  Events,
  Message,
  StringSelectMenuInteraction,
} from 'discord.js';
import { createClient, type RedisClientType } from 'redis';
import { WorkflowService } from '../workflow/workflow.service';
import { WorkflowRegistryService } from '../workflow/workflow-registry.service';
import { IdempotencyService } from '../workflow/chat/idempotency.service';
import type { ChatResponseDto } from '../workflow/chat/chat.controller';
import { S3Service } from '../workflow/storage/s3.service';
import { DiscordService } from './discord.service';
import { DiscordConfig } from './discord.config';
import type { DiscordReplyChannel } from './discord.types';

/**
 * DiscordListener — DM gateway handler. The brain of the Discord integration.
 *
 * Parity contract with ChatController (React's adapter): identical inputs to
 * WorkflowService (triggerCode/message/threadId/requestId), identical STOP
 * handling, identical idempotency-cache + response-mapping semantics. Only
 * the transport differs (Discord DMs instead of HTTP JSON).
 *
 * Per-message pipeline (each rule cheap and in order):
 * bot? → DM? → allowlisted? → partial fetch → attachment flow? → file
 * command? → STOP? → cache? → execute (locked→busy) → map → cache →
 * deliver (embed card for presents, text + chart image otherwise).
 * Any throw becomes ONE apology text — handlers never reject (an unhandled
 * rejection would kill the gateway dispatch).
 *
 * Button clicks (Confirm/Cancel under the review embed) run the identical
 * pipeline with the word as content and the interaction id as requestId —
 * text and buttons are two skins over one flow. Stale buttons (already
 * confirmed/cancelled) degrade safely: batch-less confirm becomes a
 * clarification question, never a write.
 */

/** Pending workbook-upload prompts: userId → timestamp (10 min TTL). */
const UPLOAD_PROMPT_TTL_MS = 10 * 60 * 1000;
@Injectable()
export class DiscordListener implements OnModuleInit {
  private readonly logger = new Logger(DiscordListener.name);

  constructor(
    private readonly workflowService: WorkflowService,
    private readonly workflowRegistry: WorkflowRegistryService,
    private readonly idempotencyService: IdempotencyService,
    private readonly s3Service: S3Service,
    private readonly discordService: DiscordService,
    private readonly config: DiscordConfig,
  ) {}

  /** Upload prompts awaiting a file: userId → timestamp (single instance;
   * restart loses them — the user just retypes the command). */
  private readonly uploadPrompts = new Map<string, number>();

  /** Lazy Redis connection for thread wipes (conversation state only). */
  private wipeRedis: RedisClientType | null = null;

  /**
   * Genuine deletion of a thread's conversation state: LangGraph
   * checkpoints/blobs/write-keys plus advisory locks and cancel signals.
   * FlowTracking rows (execution audit log) intentionally survive — wiping
   * bills is a separate retention concern, not conversation memory.
   * Best-effort: failures log and the rotation still gives a clean thread
   * (leftovers rot via Redis TTL).
   */
  private async wipeThread(threadId: string): Promise<number> {
    try {
      if (!this.wipeRedis) {
        this.wipeRedis = createClient({
          url: process.env.REDIS_URL || 'redis://localhost:6380',
        });
        await this.wipeRedis.connect();
      }
      const patterns = [
        `checkpoint:${threadId}:*`,
        `checkpoint_blob:${threadId}:*`,
        `checkpoint_write:${threadId}:*`,
        `write_keys_zset:${threadId}:*`,
        `agent-fox:lock:${threadId}`,
        `agent-fox:cancel:${threadId}:*`,
      ];
      let deleted = 0;
      for (const pattern of patterns) {
        const keys: string[] = await this.wipeRedis.keys(pattern);
        for (const key of keys) {
          await this.wipeRedis.del(key);
          deleted++;
        }
      }
      return deleted;
    } catch (error) {
      this.logger.warn(
        `Thread wipe best-effort failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /**
   * Fresh start, shared by the typed words and the menu option: stop
   * anything live on the old thread, wipe its stored state, rotate to a
   * timestamp-suffixed thread, confirm with a divider line, and evaporate
   * the bot's own old messages in the background (fire-and-forget — the
   * fresh start never waits on bulk deletes).
   */
  private async startFreshChat(
    userId: string,
    channel: DiscordReplyChannel,
  ): Promise<void> {
    const rotationAt = Date.now();
    const oldThread = this.threadFor(userId);
    try {
      await this.workflowService.requestStop(oldThread, 'manual');
    } catch {
      // Best effort — wipe proceeds regardless.
    }
    const wiped = await this.wipeThread(oldThread);
    this.threadSuffixes.set(userId, String(rotationAt));
    this.uploadPrompts.delete(userId);
    this.logger.log(
      `New chat for ${userId}: wiped ${wiped} stored record(s) from previous thread`,
    );
    await this.discordService.sendMessage(
      channel,
      '━━━━━ ✦ New conversation ━━━━━',
    );
    // Your messages are yours alone — no API deletes another user's words.
    // Ours evaporate above while you read on.
    void this.evaporateOwnMessages(channel, rotationAt).catch((error) => {
      this.logger.warn(
        `Own-message cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /**
   * Delete the bot's own messages older than the rotation, newest-first,
   * capped (rate-limit friendly, best effort). Skips everything else —
   * Discord grants no API to delete another user's words, so their side of
   * the history honestly remains.
   */
  private async evaporateOwnMessages(
    channel: DiscordReplyChannel,
    olderThan: number,
    cap = 200,
  ): Promise<void> {
    const selfId = this.discordService.getClient()?.user?.id;
    if (!selfId) {
      return;
    }
    let removed = 0;
    let before: string | undefined;
    while (removed < cap) {
      const fetched = await channel.messages.fetch({ limit: 100, before });
      if (fetched.size === 0) {
        break;
      }
      const batch = [...fetched.values()]
        .filter((m) => m.author.id === selfId && m.createdTimestamp < olderThan)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      for (const m of batch) {
        if (removed >= cap) {
          break;
        }
        try {
          await m.delete();
          removed++;
        } catch {
          // Per-message failures (permissions, age) never abort the sweep.
        }
      }
      const oldest = [...fetched.values()].reduce((a, b) =>
        a.createdTimestamp < b.createdTimestamp ? a : b,
      );
      before = oldest.id;
      if (fetched.size < 100) {
        break;
      }
    }
    this.logger.log(`Evaporated ${removed} own message(s) after rotation`);
  }

  onModuleInit(): void {
    const client = this.discordService.getClient();
    if (!client) {
      return;
    }
    client.on(Events.MessageCreate, (message: Message) => {
      void this.processMessage(message).catch((error) => {
        this.logger.error(
          `Discord message handling failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton()) {
        void this.processButton(interaction).catch((error) => {
          this.logger.error(
            `Discord button handling failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        return;
      }
      if (interaction.isStringSelectMenu()) {
        void this.processMenuSelect(interaction).catch((error) => {
          this.logger.error(
            `Discord menu handling failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      // Slash commands don't exist in this design — anything else ignored.
    });
  }

  /** Thread rotation for "new chat": userId → suffix (single instance;
   * restart falls back to the base thread — documented, harmless). */
  private readonly threadSuffixes = new Map<string, string>();

  /**
   * Conversation thread for a user: base `dc_<id>`, or suffixed after
   * "new chat". Old threads are never deleted — Redis TTL expires them.
   */
  private threadFor(userId: string): string {
    const suffix = this.threadSuffixes.get(userId);
    return suffix ? `dc_${userId}#${suffix}` : `dc_${userId}`;
  }

  private async processMessage(message: Message): Promise<void> {
    // Rule: ignore bots (self + others — prevents infinite loops).
    if (message.author.bot) {
      return;
    }

    // Rule: DMs only (no server, no channel filter exists in this design).
    if (message.channel.type !== ChannelType.DM) {
      return;
    }
    const channel = message.channel as DiscordReplyChannel;

    // Rule: allowlist — strangers get NOTHING (no reply, no bill, no sheet).
    if (!this.config.allowedUserIds.includes(message.author.id)) {
      this.logger.warn(
        `Ignoring DM from non-allowlisted user ${message.author.id} (${message.author.username})`,
      );
      return;
    }

    // Rule: partials can arrive content-less — fetch before reading.
    if (message.partial) {
      try {
        await message.fetch();
      } catch {
        return;
      }
    }
    const content = (message.content || '').trim();
    const threadId = this.threadFor(message.author.id);
    const requestId = message.id;

    // Rule: workbook file handling comes before everything textual — an
    // attachment post usually carries no text at all.
    if (message.attachments.size > 0) {
      await this.processAttachment(message, channel);
      return;
    }
    if (content === '') {
      // Stickers with no text: honest boundary, same always.
      await this.discordService.sendMessage(
        channel,
        'I can only read text messages — please type your expense or question.',
      );
      return;
    }

    // Rule: workbook file commands (direct S3 reuse — the exact methods
    // behind React's download/upload endpoints; zero duplication).
    if (isDownloadCommand(content)) {
      await this.sendWorkbookFlow(channel);
      return;
    }
    if (isUploadCommand(content)) {
      await this.promptUploadFlow(message.author.id, channel);
      return;
    }

    // Rule: command center + fresh starts (exact matches only — transaction
    // text can never trip these).
    const lowered = content.toLowerCase();
    if (
      lowered === '/commands' ||
      lowered === 'commands' ||
      lowered === 'help' ||
      lowered === 'menu'
    ) {
      await this.discordService.sendCommandMenu(channel);
      return;
    }
    if (isNewChatCommand(content)) {
      await this.startFreshChat(message.author.id, channel);
      return;
    }

    // STEP 0: STOP interception at the request boundary (mirrors
    // ChatController exactly). Exact keyword only.
    if (content.toLowerCase() === 'stop') {
      const { stopped } = await this.workflowService.requestStop(
        threadId,
        'manual',
      );
      await this.discordService.sendMessage(
        channel,
        stopped ? 'Flow stopped.' : 'No flow is currently running.',
      );
      return;
    }

    await this.executeAndDeliver(
      threadId,
      requestId,
      content,
      channel,
    );
  }

  /**
   * Workbook download, shared by the typed command and the menu option.
   */
  private async sendWorkbookFlow(channel: DiscordReplyChannel): Promise<void> {
    try {
      const workbook = await this.s3Service.downloadWorkbook();
      await this.discordService.sendWorkbookFile(channel, workbook);
    } catch (error) {
      this.logger.error(
        `Discord workbook download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.discordService.sendMessage(
        channel,
        'Sorry, I could not fetch the workbook right now. Please try again.',
      );
    }
  }

  /**
   * Upload prompt, shared by the typed command and the menu option.
   */
  private async promptUploadFlow(
    userId: string,
    channel: DiscordReplyChannel,
  ): Promise<void> {
    this.uploadPrompts.set(userId, Date.now());
    await this.discordService.sendMessage(
      channel,
      'Please post the workbook file here (.xlsx) and I will replace the current one with it.',
    );
  }

  /**
   * Confirm/Cancel button clicks under the review embed. Same pipeline as
   * the words (same thread, interaction id as requestId) — text and buttons
   * are two skins over one flow. Stale buttons degrade safely: a
   * batch-less confirm becomes a clarification question, never a write.
   */
  private async processButton(interaction: ButtonInteraction): Promise<void> {
    if (
      interaction.customId !== 'agentfox:confirm' &&
      interaction.customId !== 'agentfox:cancel'
    ) {
      return;
    }
    if (interaction.user.bot) {
      return;
    }
    if (!this.config.allowedUserIds.includes(interaction.user.id)) {
      return;
    }
    const rawChannel = interaction.channel;
    if (!rawChannel) {
      return;
    }
    // DM channels can arrive partial — fetch before sending, or the reply
    // throws and the (already deferred) click dies silently.
    let channel: DiscordReplyChannel;
    try {
      channel =
        rawChannel.partial === true
          ? ((await rawChannel.fetch()) as unknown as DiscordReplyChannel)
          : (rawChannel as DiscordReplyChannel);
    } catch {
      return;
    }
    try {
      await interaction.deferUpdate();
    } catch {
      return;
    }
    const content =
      interaction.customId === 'agentfox:confirm' ? 'confirm' : 'cancel';
    await this.executeAndDeliver(
      this.threadFor(interaction.user.id),
      interaction.id,
      content,
      channel,
    );
  }

  /**
   * Command-menu option picks. Menu and typed words dispatch to the same
   * handlers — the menu is a skin, never a second implementation. Guidance
   * options (log/ask) can only explain, since typing has to come from the
   * user — stated honestly instead of pretending.
   */
  private async processMenuSelect(
    interaction: StringSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.customId !== 'agentfox:menu') {
      return;
    }
    if (interaction.user.bot) {
      return;
    }
    if (!this.config.allowedUserIds.includes(interaction.user.id)) {
      return;
    }
    let channel: DiscordReplyChannel | null = null;
    try {
      const raw = interaction.channel;
      if (!raw) {
        return;
      }
      channel =
        raw.partial === true
          ? ((await raw.fetch()) as unknown as DiscordReplyChannel)
          : (raw as DiscordReplyChannel);
    } catch {
      return;
    }
    try {
      await interaction.deferUpdate();
    } catch {
      return;
    }
    const picked = interaction.values[0] || '';
    switch (picked) {
      case 'menu:download':
        await this.sendWorkbookFlow(channel);
        return;
      case 'menu:upload':
        await this.promptUploadFlow(interaction.user.id, channel);
        return;
      case 'menu:newchat':
        await this.startFreshChat(interaction.user.id, channel);
        return;
      case 'menu:log':
        await this.discordService.sendMessage(
          channel,
          'Sure — type it like "spent 500 on groceries via phonepay" and I will take it from there.',
        );
        return;
      case 'menu:ask':
        await this.discordService.sendMessage(
          channel,
          'Go ahead — e.g. "how much did I spend this month?" or "what is my bank balance?".',
        );
        return;
      default:
        return;
    }
  }

  /**
   * Workbook attachment handling: only when a fresh upload prompt is
   * outstanding for this user (10 min TTL), only for .xlsx-looking files.
   * Anything else gets one hint line (or silence when unrelated).
   */
  private async processAttachment(
    message: Message,
    channel: DiscordReplyChannel,
  ): Promise<void> {
    const promptedAt = this.uploadPrompts.get(message.author.id) || 0;
    const prompted =
      promptedAt > 0 && Date.now() - promptedAt < UPLOAD_PROMPT_TTL_MS;
    const file = message.attachments.first();
    const looksXlsx =
      !!file &&
      ((file.name || '').toLowerCase().endsWith('.xlsx') ||
        (file.contentType || '').includes('spreadsheet') ||
        (file.contentType || '').includes('excel'));
    if (!prompted || !looksXlsx) {
      if (looksXlsx) {
        // Right file, no prompt: one hint line, file untouched.
        await this.discordService.sendMessage(
          channel,
          'To replace the workbook with this file, first say "upload the workbook".',
        );
      }
      return;
    }
    this.uploadPrompts.delete(message.author.id);
    try {
      const res = await fetch(file!.url);
      if (!res.ok) {
        throw new Error(`Attachment download failed: HTTP ${res.status}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) {
        throw new Error('Attachment download returned empty file');
      }
      // SAME code path as React's upload endpoint — replace, nothing else.
      await this.s3Service.uploadWorkbook(buffer);
      await this.discordService.sendMessage(
        channel,
        `Workbook replaced successfully (${buffer.length} bytes). Balances and categories now read from the new file.`,
      );
    } catch (error) {
      this.logger.error(
        `Discord workbook upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.discordService.sendMessage(
        channel,
        'Sorry, I could not use that file. Please post a valid .xlsx workbook.',
      );
    }
  }

  /**
   * Shared AI turn: idempotency cache → execute → busy handling → mapping →
   * cache → deliver. Used identically by text messages and button clicks.
   */
  private async executeAndDeliver(
    threadId: string,
    requestId: string,
    content: string,
    channel: DiscordReplyChannel,
  ): Promise<void> {
    // Typing indicator for the (possibly long) AI turn; re-armed below.
    await this.discordService.sendTyping(channel);
    const typingTimer = setInterval(() => {
      void this.discordService.sendTyping(channel);
    }, 8000);

    try {
      // STEP 1: resolve workflow (for workflowId used by idempotency cache).
      const workflow =
        await this.workflowRegistry.findByTriggerCode('manual');
      const workflowId = workflow.id;

      // STEP 2: idempotency cache FIRST (duplicate deliveries replay text,
      // never re-execute).
      const cached = await this.idempotencyService.getCachedResponse(
        requestId,
        workflowId,
      );
      if (cached?.response) {
        this.logger.log(`Discord replaying cached reply for ${requestId}`);
        await this.deliver(channel, {
          ...cached,
          pendingBatch: cached.pendingBatch || null,
          chartImage: cached.chartImage || null,
        });
        return;
      }

      // STEP 3: execute (thread lock lives inside WorkflowService).
      const startTime = Date.now();
      const result = await this.workflowService.execute({
        triggerCode: 'manual',
        message: content,
        threadId,
        requestId,
      });

      // Locked: a turn is already running on this thread — busy reply.
      if (result.status === 'locked') {
        await this.discordService.sendMessage(
          channel,
          'Give me a moment — still working on your previous message.',
        );
        return;
      }

      // STEP 4: map to text (ChatController response-mapping parity — NEVER
      // result.response, which does not exist on ExecutionResult).
      const replyText =
        result.result?.lastResponse ||
        result.error ||
        'Sorry, I could not process that.';
      const chartImage: string | null = result.result?.chartImage || null;

      const response: ChatResponseDto = {
        success: result.status === 'completed',
        response: replyText,
        pendingBatch: result.result?.pendingBatch || null,
        chartImage,
        error: result.error || null,
        workflowMode: result.result?.workflowMode || 'IDLE',
        cached: false,
        metadata: {
          llmCalls: result.result?.metadata?.llmCalls || 0,
          toolCalls: result.result?.metadata?.toolCalls || 0,
          executionTimeMs: Date.now() - startTime,
        },
      };

      // STEP 5: cache successful turns for idempotency.
      if (result.status === 'completed') {
        await this.idempotencyService.cacheResponse(
          requestId,
          response,
          workflowId,
        );
      }

      // STEP 6: deliver.
      await this.deliver(channel, response);
    } catch (error) {
      this.logger.error(
        `Discord processing failed for ${requestId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        await this.discordService.sendMessage(
          channel,
          'Sorry, something went wrong handling that message. Please try again.',
        );
      } catch {
        // Best effort only.
      }
    } finally {
      clearInterval(typingTimer);
    }
  }

  /**
   * Deliver one mapped response.
   *
   * Standing rule: generated TEXT IS NEVER SILENTLY DROPPED. The fresh
   * present is the sole exception and it is not a drop — the card carries
   * the identical information, reformatted, and the footer keeps the hint.
   * - Fresh present (PENDING + batch + the present text itself): embed card
   *   ONLY — sending both would duplicate the card.
   * - PENDING + batch + anything else (overdraft refusal, diverted balance
   *   answer): text FIRST (it carries new information — hiding it behind a
   *   re-rendered card is exactly the "confirm shows the card again" bug),
   *   then the card so Confirm/Cancel stay clickable.
   * - Otherwise: text, then an optional chart image.
   */
  private async deliver(
    channel: DiscordReplyChannel,
    response: ChatResponseDto,
  ): Promise<void> {
    const hasBatch =
      response.workflowMode === 'PENDING_CONFIRMATION' &&
      !!response.pendingBatch &&
      response.pendingBatch.length > 0;
    const isFreshPresent =
      hasBatch && response.response.trim().endsWith('Confirm? (yes/no/edit)');
    if (isFreshPresent) {
      await this.discordService.sendReviewCard(channel, response.pendingBatch || []);
      return;
    }
    await this.discordService.sendMessage(channel, response.response);
    if (hasBatch) {
      await this.discordService.sendReviewCard(channel, response.pendingBatch || []);
    }
    if (response.chartImage) {
      try {
        await this.discordService.sendImageAttachment(
          channel,
          Buffer.from(response.chartImage, 'base64'),
          'chart.png',
        );
      } catch (error) {
        this.logger.warn(
          `Chart attachment failed, text already sent: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.discordService.sendMessage(
          channel,
          '(The chart image could not be delivered here.)',
        );
      }
    }
  }
}

/**
 * Deterministic file-command matchers (meaning-based word sets in either
 * order, never example phrases). Both a file word AND an action word are
 * required, so transaction text can never trip them.
 */
function isDownloadCommand(text: string): boolean {
  const t = text.toLowerCase();
  const hasFileWord =
    /\b(workbook|excel|xlsx|spreadsheet|budget)\b/.test(t);
  const hasGetWord = /\b(download|export|send|get)\b/.test(t);
  return hasFileWord && hasGetWord;
}

function isUploadCommand(text: string): boolean {
  const t = text.toLowerCase();
  const hasFileWord =
    /\b(workbook|excel|xlsx|spreadsheet|sheet|budget)\b/.test(t);
  const hasPutWord = /\b(upload|replace|update)\b/.test(t);
  return hasFileWord && hasPutWord;
}

/**
 * Fresh-start matchers ("new chat", "start over", "reset conversation").
 * Deliberately disjoint from transaction/edit vocabulary ("start a
 * transaction" must never match) — exact-phrase anchored.
 */
function isNewChatCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(new chat|start over|start a new chat|reset( the)? chat|reset conversation|clear conversation|fresh chat)$/.test(
    t,
  );
}
