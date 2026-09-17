/**
 * LangGraph Module Types
 * 
 * Generic types and interfaces for LangGraph infrastructure
 */

import { StateGraph } from '@langchain/langgraph';
import { RunnableConfig } from '@langchain/core/runnables';

/**
 * Compiled state graph with checkpointing support
 * Using instance method return type since StateGraph is a class
 */
export type CompiledStateGraph = ReturnType<InstanceType<typeof StateGraph>['compile']>;

/**
 * Node function signature for graph nodes
 */
export type NodeFunction = (state: any) => Promise<any> | any;

/**
 * Graph compilation configuration
 */
export interface CompileConfig {
  checkpointer?: any;
  // Additional config options can be added here
}

/**
 * Execution configuration for graph invocation
 */
export interface ExecutionConfig extends RunnableConfig {
  configurable?: {
    thread_id: string;
    checkpoint_ns?: string;
    checkpoint_id?: string;
  };
}

/**
 * Checkpoint tuple returned by getTuple
 */
export interface CheckpointTuple {
  checkpoint: {
    channel_values: any;
    [key: string]: any;
  };
  config: RunnableConfig;
  metadata: any;
  parentConfig?: RunnableConfig;
}
