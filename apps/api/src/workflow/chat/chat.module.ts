/**
 * Chat Module
 * 
 * Provides the chat API endpoint and idempotency service.
 */

import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { IdempotencyService } from './idempotency.service';
import { DatabaseModule } from '../../database/database.module';
import { WorkflowModule } from '../workflow.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [DatabaseModule, WorkflowModule, StorageModule],
  controllers: [ChatController],
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class ChatModule {}
