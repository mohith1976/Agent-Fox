/**
 * Tool Executor Service
 *
 * Routes tool_code to implementation (controlled switch, NOT eval).
 * Validates tool exists in DB before execution.
 * Enforces per-workflow tool allow-list from agent_workflows.toolsId.
 */

import { Injectable, Logger } from '@nestjs/common';
import { LogTransactionImpl } from './implementations/log-transaction.impl';
import { QueryTransactionsImpl } from './implementations/query-transactions.impl';
import { GenerateChartImpl } from './implementations/generate-chart.impl';
import { ReadTerminologyImpl } from './implementations/read-terminology.impl';
import { ToolRegistryService } from './tool-registry.service';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private readonly logTransactionImpl: LogTransactionImpl,
    private readonly queryTransactionsImpl: QueryTransactionsImpl,
    private readonly generateChartImpl: GenerateChartImpl,
    private readonly readTerminologyImpl: ReadTerminologyImpl,
    private readonly toolRegistry: ToolRegistryService,
  ) {}

  /**
   * Execute a tool by its code.
   *
   * Process:
   * 1. [ARCHITECTURE] Enforce workflow-scoped tool allow-list (agent_workflows.toolsId)
   * 2. Validate tool exists in DB (tool_definitions table)
   * 3. Route to implementation via controlled switch (NOT eval)
   * 4. Execute and return result
   *
   * @param toolCode - The tool_code from tool_definitions to execute
   * @param input - Tool-specific input parameters
   * @param allowedToolCodes - Optional: tool_code strings from agent_workflows.toolsId.
   *   When provided, the tool is rejected if not in this list.
   *   When omitted (e.g., in tests), all DB-registered tools are accessible.
   */
  async execute(
    toolCode: string,
    input: any,
    allowedToolCodes?: string[],
  ): Promise<any> {
    this.logger.debug(`Executing tool: ${toolCode}`);

    // Step 1: Enforce workflow-scoped allow-list
    // This wires agent_workflows.toolsId → actual tool execution restriction
    if (allowedToolCodes && allowedToolCodes.length > 0) {
      if (!allowedToolCodes.includes(toolCode)) {
        this.logger.warn(
          `Tool "${toolCode}" is not in the workflow allow-list: [${allowedToolCodes.join(', ')}]`,
        );
        throw new Error(
          `Tool "${toolCode}" is not permitted for this workflow. ` +
          `Allowed tools: [${allowedToolCodes.join(', ')}]`,
        );
      }
    }

    // Step 2: Validate tool exists in DB
    const tool = await this.toolRegistry.findByCode(toolCode);
    if (!tool) {
      throw new Error(`Tool not found in registry: ${toolCode}`);
    }

    // Step 3: Route to implementation (controlled switch, NOT eval)
    switch (toolCode) {
      case 'log_transaction':
        return this.logTransactionImpl.execute(input);

      case 'query_transactions':
        return this.queryTransactionsImpl.execute(input);

      case 'generate_chart':
        return this.generateChartImpl.execute(input);

      case 'read_terminology':
        return this.readTerminologyImpl.execute(input);

      default:
        throw new Error(`Tool implementation not found: ${toolCode}`);
    }
  }
}
