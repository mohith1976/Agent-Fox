import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as path from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { WorkflowModule } from './workflow/workflow.module';
import { LlmModule } from './llm/llm.module';
import { ChatModule } from './workflow/chat/chat.module';

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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
