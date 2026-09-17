/**
 * LangGraph Module
 * 
 * Global LangGraph infrastructure module:
 * - Configures and exports LangGraphService
 * - Initializes official RedisSaver checkpoint persistence
 * - Provides graph compilation and execution utilities
 */

import { Module } from '@nestjs/common';
import { LangGraphService } from './langgraph.service';
import { LangGraphRunner } from './langgraph.runner';

@Module({
  providers: [LangGraphService, LangGraphRunner],
  exports: [LangGraphService, LangGraphRunner],
})
export class LangGraphModule {}
