import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { ChatModule } from '../workflow/chat/chat.module';
import { StorageModule } from '../workflow/storage/storage.module';
import { DiscordConfig } from './discord.config';
import { DiscordService } from './discord.service';
import { DiscordListener } from './discord.listener';

/**
 * DiscordModule — Discord DM channel adapter.
 *
 * Hexagonal boundary: imports WorkflowModule (WorkflowService,
 * WorkflowRegistryService) and ChatModule (IdempotencyService) and consumes
 * them read-only. NOTHING outside this folder is modified by the feature
 * (see app.module.ts — the single import line).
 */
@Module({
  imports: [WorkflowModule, ChatModule, StorageModule],
  providers: [DiscordConfig, DiscordService, DiscordListener],
})
export class DiscordModule {}
