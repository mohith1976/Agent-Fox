import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { v4 as uuid } from 'uuid';
import { LangGraphService } from '../langgraph/langgraph.service';
import { WorkflowRegistryService } from './workflow-registry.service';
import { FlowTrackingService } from './flow-tracking.service';
import { ToolRegistryService } from '../tools/tool-registry.service';

/**
 * Execution Result Interface
 */
export interface ExecutionResult {
  threadId: string;
  status: 'completed' | 'failed' | 'locked' | 'cancelled';
  error?: string;
  result?: any;
  metadata?: {
    actualTokenCount: number;
    modelUsed: string;
    actualCost: number;
  };
}

/**
 * Conversation State Interface
 */
export interface ConversationState {
  messages: any[];
  pendingBatch: any | null;
  lastResponse: string;
  status: string;
}

/**
 * Workflow Service
 * 
 * Central orchestrator for workflow execution with:
 * - Thread locking (prevents concurrent race conditions)
 * - Lock renewal heartbeat (prevents stale locks)
 * - Ownership-loss detection (terminates on lock loss)
 * - Cancellation checking
 * - Flow tracking integration
 * - State recovery
 * 
 * Architecture:
 * - Delegates to WorkflowRegistryService for workflow lookup
 * - Delegates to FlowTrackingService for execution monitoring
 * - Delegates to LangGraphService for state recovery
 * - Uses Redis for distributed locking
 */
@Injectable()
export class WorkflowService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkflowService.name);
  private lockRenewals: Map<string, NodeJS.Timeout> = new Map();
  private redis!: RedisClientType;

  constructor(
    private readonly langGraphService: LangGraphService,
    private readonly workflowRegistry: WorkflowRegistryService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly flowTrackingService: FlowTrackingService,
  ) {
    // Initialize Redis client for locks (use same package as RedisSaver)
    this.initializeRedis();
  }

  private async initializeRedis() {
    this.redis = createClient({
      url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6380'}`,
      password: process.env.REDIS_PASSWORD,
      database: parseInt(process.env.REDIS_DB || '0'),
    });

    this.redis.on('error', (err) => {
      this.logger.error(`Redis client error: ${err.message}`);
    });

    await this.redis.connect();
    this.logger.log('Redis client connected for thread locking');
  }

  /**
   * Execute workflow with full orchestration
   * 
   * Flow:
   * 1. Get or create threadId
   * 2. Acquire thread lock (prevents concurrent execution)
   * 3. Check cancellation signal
   * 4. Lookup workflow configuration
   * 5. Create flow tracking record
   * 6. Execute workflow implementation
   * 7. Update flow tracking with results
   * 8. Release thread lock (always)
   * 
   * @param input - Execution parameters
   * @returns Execution result with threadId
   */
  async execute(input: {
    triggerCode: string;
    message: string;
    threadId?: string;
    requestId: string;
  }): Promise<ExecutionResult> {
    // 1. Get or create threadId
    const threadId = input.threadId || uuid();

    // 2. Acquire thread lock (MANDATORY - prevents concurrent race)
    const lockAcquired = await this.acquireThreadLock(
      threadId,
      input.requestId,
    );
    if (!lockAcquired) {
      this.logger.warn(
        `Lock acquisition failed for thread ${threadId}, request ${input.requestId}`,
      );
      return {
        error: 'Another request is processing this conversation. Please wait.',
        threadId,
        status: 'locked',
      };
    }

    try {
      // 3. Check cancellation signal
      const cancelled = await this.checkCancellation(
        threadId,
        input.requestId,
      );
      if (cancelled) {
        this.logger.log(
          `Execution cancelled for thread ${threadId}, request ${input.requestId}`,
        );
        return { status: 'cancelled', threadId };
      }

      // 4. Lookup workflow via WorkflowRegistryService
      const workflow =
        await this.workflowRegistry.findByTriggerCode(input.triggerCode);

      // 5. Create FlowTracking record (status: running)
      const flowTracking = await this.flowTrackingService.start({
        workflowId: workflow.id,
        data: { input },
      });

      // Load allowed tools from DB (agent_workflows.toolsId → tool_definitions)
      // These are passed to the workflow so ToolExecutorService can enforce the allow-list
      const allowedTools = await this.toolRegistry.findByIds(
        (workflow.toolsId as string[]) || [],
      );

      this.logger.log(
        `Loaded ${allowedTools.length} allowed tools for workflow "${workflow.name}": ` +
        `[${allowedTools.map((t) => t.toolCode).join(', ')}]`,
      );

      // 6. Execute workflow implementation
      const expenseWorkflow = await this.workflowRegistry.getImplementation(
        workflow.id,
      );
      const result = await expenseWorkflow.execute({
        message: input.message,
        threadId,
        requestId: input.requestId,
        workflowConfig: workflow,
        allowedTools, // ← DB allow-list enforced inside ToolExecutorService
      });

      // 7. Update FlowTracking (status: completed/failed)
      // Real measured figures from graph-state metering (nodes fold in
      // per-call counts + SDK token usage). Cost stays 0 until a pricing
      // table is configured — it is reported as unknown, not fabricated.
      const executionMetadata = {
        actualTokenCount: result.metadata?.tokens || 0,
        modelUsed: process.env.AZURE_AI_DEPLOYMENT || 'unknown',
        actualCost: 0,
      };

      await this.flowTrackingService.complete(flowTracking.id, {
        status: result.error ? 'failed' : 'completed',
        data: { input, output: result },
        tokens: executionMetadata.actualTokenCount,
        model: executionMetadata.modelUsed,
        cost: executionMetadata.actualCost,
      });

      // 8. Return planned ExecutionResult shape (status + result wrapper).
      // ChatController depends on this contract: status 'completed' drives
      // success mapping AND idempotency caching; result.lastResponse is the
      // user-facing reply. Do NOT spread the raw workflow output here.
      const status = result.error ? 'failed' : 'completed';
      return {
        threadId,
        status,
        ...(result.error ? { error: result.error } : {}),
        result: {
          ...result,
          lastResponse: result.response || result.lastResponse || '',
        },
        metadata: executionMetadata,
      };
    } catch (error) {
      this.logger.error(
        `Workflow execution failed for thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return {
        threadId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // 9. Release thread lock (ALWAYS)
      await this.releaseThreadLock(threadId, input.requestId);
    }
  }

  /**
   * Recover conversation state from thread
   * 
   * Delegates to LangGraphService to extract workflow state from checkpoint
   * Maps workflow state to conversation state for frontend
   * 
   * @param threadId - Thread ID to recover
   * @returns Conversation state or idle state
   */
  async recoverState(threadId: string): Promise<ConversationState> {
    try {
      // Delegate to LangGraphService to extract workflow state
      // WorkflowService does NOT know about checkpoint internal structure
      const state =
        await this.langGraphService.getWorkflowState<any>(threadId);

      if (!state) {
        return { messages: [], pendingBatch: null, lastResponse: '', status: 'idle' };
      }

      // Map workflow state to conversation state
      return {
        messages: state.messages || [],
        pendingBatch: state.pendingBatch || null,
        lastResponse: state.lastResponse || '',
        status: state.workflowMode || 'IDLE',
      };
    } catch (error) {
      this.logger.error(
        `State recovery failed for thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return { messages: [], pendingBatch: null, lastResponse: '', status: 'error' };
    }
  }

  /**
   * CRITICAL: Lock Acquisition
   * 
   * Uses Redis SET NX (only if not exists) with ownership token (requestId)
   * Starts lock renewal heartbeat on success
   * 
   * @param threadId - Thread to lock
   * @param requestId - Ownership token
   * @returns true if lock acquired, false otherwise
   */
  private async acquireThreadLock(
    threadId: string,
    requestId: string,
  ): Promise<boolean> {
    const lockKey = `agent-fox:lock:${threadId}`;
    const lockTTL = parseInt(process.env.LOCK_TTL_SECONDS || '600'); // 10 minutes default

    try {
      // SET NX (only if not exists) with ownership token
      const result = await this.redis.set(lockKey, requestId, {
        NX: true,
        EX: lockTTL,
      });

      if (result === 'OK') {
        this.logger.log(
          `Lock acquired for thread ${threadId} by request ${requestId}`,
        );
        // Start lock renewal heartbeat
        this.startLockRenewal(threadId, requestId);
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error(`Lock acquisition failed: ${error}`);
      return false;
    }
  }

  /**
   * CRITICAL: Lock Release
   * 
   * Ownership-safe release: only deletes lock if we own it
   * Stops lock renewal heartbeat
   * 
   * @param threadId - Thread to unlock
   * @param requestId - Ownership token
   */
  private async releaseThreadLock(
    threadId: string,
    requestId: string,
  ): Promise<void> {
    const lockKey = `agent-fox:lock:${threadId}`;

    // Stop lock renewal heartbeat
    this.stopLockRenewal(threadId, requestId);

    try {
      // Only release if we own the lock (ownership-safe)
      const script = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        else
          return 0
        end
      `;

      const released = await this.redis.eval(script, {
        keys: [lockKey],
        arguments: [requestId],
      });

      if (released === 1) {
        this.logger.log(
          `Lock released for thread ${threadId} by request ${requestId}`,
        );
      } else {
        this.logger.warn(
          `Lock release failed for thread ${threadId}: not owned by request ${requestId}`,
        );
      }
    } catch (error) {
      this.logger.error(`Lock release error: ${error}`);
    }
  }

  /**
   * CRITICAL: Lock Renewal Heartbeat
   * 
   * Periodically extends lock TTL while execution is ongoing
   * Detects ownership loss and sets termination signal
   * 
   * Mechanism:
   * 1. Every LOCK_RENEW_INTERVAL_SECONDS, check lock ownership
   * 2. If we still own it, extend TTL
   * 3. If ownership lost, set agent-fox:ownership-lost signal
   * 4. Workflow nodes check this signal and terminate
   * 
   * @param threadId - Thread being locked
   * @param requestId - Ownership token
   */
  private startLockRenewal(threadId: string, requestId: string): void {
    const lockKey = `agent-fox:lock:${threadId}`;
    const renewKey = `${threadId}:${requestId}`;
    const renewInterval =
      parseInt(process.env.LOCK_RENEW_INTERVAL_SECONDS || '120') * 1000; // 2 minutes default
    const lockTTL = parseInt(process.env.LOCK_TTL_SECONDS || '600'); // 10 minutes default

    // Clear any existing renewal for this thread
    this.stopLockRenewal(threadId, requestId);

    // Set up periodic renewal
    const intervalId = setInterval(async () => {
      try {
        // Ownership-safe renewal: only extend if we own the lock
        const script = `
          if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("EXPIRE", KEYS[1], ARGV[2])
          else
            return 0
          end
        `;

        const renewed = await this.redis.eval(script, {
          keys: [lockKey],
          arguments: [requestId, lockTTL.toString()],
        });

        if (!renewed) {
          // We lost ownership - set execution termination signal
          this.logger.error(
            `Lock ownership lost during renewal for thread ${threadId}, request ${requestId}`,
          );

          // Set ownership-lost signal (checked by workflow nodes)
          const ownershipLostKey = `agent-fox:ownership-lost:${threadId}:${requestId}`;
          await this.redis.set(ownershipLostKey, '1', { EX: 300 }); // 5 min TTL

          // Stop renewal immediately
          this.stopLockRenewal(threadId, requestId);

          // Workflow will check this signal and terminate at next boundary
        } else {
          this.logger.debug(
            `Lock renewed for thread ${threadId}, request ${requestId}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Lock renewal failed for thread ${threadId}, request ${requestId}: ${error instanceof Error ? error.message : String(error)}`,
        );

        // On renewal failure, set ownership-lost signal
        const ownershipLostKey = `agent-fox:ownership-lost:${threadId}:${requestId}`;
        try {
          await this.redis.set(ownershipLostKey, '1', { EX: 300 });
        } catch (redisError) {
          this.logger.error(
            `Failed to set ownership-lost signal: ${redisError instanceof Error ? redisError.message : String(redisError)}`,
          );
        }

        // Stop renewal
        this.stopLockRenewal(threadId, requestId);
      }
    }, renewInterval);

    this.lockRenewals.set(renewKey, intervalId);
    this.logger.log(
      `Lock renewal started for thread ${threadId}, request ${requestId}`,
    );
  }

  /**
   * Stop lock renewal heartbeat
   * 
   * @param threadId - Thread ID
   * @param requestId - Ownership token
   */
  private stopLockRenewal(threadId: string, requestId: string): void {
    const renewKey = `${threadId}:${requestId}`;
    const intervalId = this.lockRenewals.get(renewKey);

    if (intervalId) {
      clearInterval(intervalId);
      this.lockRenewals.delete(renewKey);
      this.logger.debug(
        `Lock renewal stopped for thread ${threadId}, request ${requestId}`,
      );
    }
  }

  /**
   * Check if ownership was lost during execution
   * 
   * This signal is set by lock renewal when ownership loss is detected
   * Workflow nodes check this before expensive operations
   * 
   * @param threadId - Thread ID
   * @param requestId - Ownership token
   * @returns true if ownership lost
   */
  async checkOwnershipLoss(
    threadId: string,
    requestId: string,
  ): Promise<boolean> {
    const key = `agent-fox:ownership-lost:${threadId}:${requestId}`;
    const signal = await this.redis.get(key);
    return signal === '1';
  }

  /**
   * Check if execution was cancelled
   * 
   * @param threadId - Thread ID
   * @param requestId - Request ID
   * @returns true if cancelled
   */
  private async checkCancellation(
    threadId: string,
    requestId: string,
  ): Promise<boolean> {
    const key = `agent-fox:cancel:${threadId}:${requestId}`;
    const signal = await this.redis.get(key);
    return signal === '1';
  }

  /**
   * Set cancellation signal
   * Called by external cancellation endpoint
   * 
   * @param threadId - Thread ID
   * @param requestId - Request ID
   */
  async setCancellation(threadId: string, requestId: string): Promise<void> {
    const key = `agent-fox:cancel:${threadId}:${requestId}`;
    await this.redis.set(key, '1', { EX: 300 }); // 5 min TTL
    this.logger.log(`Cancellation signal set for thread ${threadId}`);
  }

  /**
   * Cooperative STOP support (architecture §5.4).
   *
   * Two cases:
   * 1. ACTIVE execution (thread lock held): set the transient cancellation
   *    signal keyed to the ACTIVE requestId. The running workflow checks it
   *    at its next node boundary and terminates without committing.
   * 2. WAITING checkpoint (clarification/confirmation, no lock): the graph
   *    already finished, so there is nothing to signal — instead clear the
   *    waiting state so the session actually ends and the next message starts
   *    fresh instead of resuming the abandoned flow.
   *
   * @param threadId - Thread to stop
   * @param triggerCode - Workflow selector for waiting-state clearing
   * @returns what was stopped Signalled active run and/or cleared waiting state
   */
  async requestStop(
    threadId: string,
    triggerCode?: string,
  ): Promise<{ stopped: boolean; cleared: boolean }> {
    let activeRequestId: string | null = null;
    try {
      activeRequestId = await this.redis.get(`agent-fox:lock:${threadId}`);
    } catch (error) {
      this.logger.error(`STOP: failed to read lock for thread ${threadId}: ${error}`);
      return { stopped: false, cleared: false };
    }

    if (activeRequestId) {
      const key = `agent-fox:cancel:${threadId}:${activeRequestId}`;
      await this.redis.set(key, '1', { EX: 60 }); // 60 sec transient signal
      this.logger.log(`STOP signalled for thread ${threadId}, active request ${activeRequestId}`);
      return { stopped: true, cleared: false };
    }

    // No active run — try to clear a waiting checkpoint instead.
    if (triggerCode) {
      try {
        const workflow =
          await this.workflowRegistry.findByTriggerCode(triggerCode);
        const impl =
          await this.workflowRegistry.getImplementation(workflow.id);
        if (impl.clearWaitingState) {
          const cleared = await impl.clearWaitingState(threadId);
          return { stopped: cleared, cleared };
        }
      } catch (error) {
        this.logger.error(`STOP: waiting-state clear failed: ${error}`);
      }
    }

    return { stopped: false, cleared: false };
  }

  /**
   * Cleanup on module destruction
   * Stop all lock renewals
   */
  async onModuleDestroy() {
    this.logger.log('Stopping all lock renewals');
    this.lockRenewals.forEach((intervalId) => clearInterval(intervalId));
    this.lockRenewals.clear();
    await this.redis.quit();
  }
}
