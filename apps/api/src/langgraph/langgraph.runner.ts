/**
 * LangGraph Runner
 * 
 * Executes compiled graphs with proper configuration
 */

import { Injectable, Logger } from '@nestjs/common';
import { CompiledStateGraph, ExecutionConfig } from './langgraph.types';

@Injectable()
export class LangGraphRunner {
  private readonly logger = new Logger(LangGraphRunner.name);

  /**
   * Execute a compiled graph with the given input and configuration
   */
  async execute<TOutput = any>(
    graph: CompiledStateGraph,
    input: any,
    config: ExecutionConfig,
  ): Promise<TOutput> {
    this.logger.debug(
      `Executing graph with thread_id: ${config.configurable?.thread_id}`,
    );

    try {
      const result = await graph.invoke(input as any, config);
      return result as TOutput;
    } catch (error) {
      this.logger.error(
        `Graph execution failed for thread ${config.configurable?.thread_id}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Stream graph execution (for future streaming support)
   */
  async *stream<TOutput = any>(
    graph: CompiledStateGraph,
    input: any,
    config: ExecutionConfig,
  ): AsyncGenerator<TOutput> {
    this.logger.debug(
      `Streaming graph with thread_id: ${config.configurable?.thread_id}`,
    );

    try {
      const stream = await graph.stream(input as any, config);
      for await (const chunk of stream) {
        yield chunk as TOutput;
      }
    } catch (error) {
      this.logger.error(
        `Graph streaming failed for thread ${config.configurable?.thread_id}:`,
        error,
      );
      throw error;
    }
  }
}
