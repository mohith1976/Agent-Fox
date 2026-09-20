import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as path from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { WorkflowModule } from './workflow/workflow.module';
import { LlmModule } from './llm/llm.module';
import { ChatModule } from './workflow/chat/chat.module';
import { DiscordModule } from './discord/discord.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env', // Relative path from compiled dist/ directory
    }),
    DatabaseModule,
    WorkflowModule,
    LlmModule,
    ChatModule,
    // Discord DM channel adapter (additive only — no existing route,
    // handler, prompt or workflow touched).
    DiscordModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
