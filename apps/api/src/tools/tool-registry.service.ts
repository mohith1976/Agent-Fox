/**
 * Tool Registry Service
 * 
 * Loads tool definitions from the database (tool_definitions table)
 * Provides lookup by IDs and by tool code
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ToolDefinition } from './tool.types';

@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find multiple tools by their PIDs
   * Used by WorkflowService to load allowed tools for a workflow
   */
  async findByIds(pids: string[]): Promise<ToolDefinition[]> {
    this.logger.debug(`Finding tools by IDs: ${pids.join(', ')}`);

    const tools = await this.prisma.toolDefinition.findMany({
      where: {
        pid: { in: pids },
        deletedAt: null,
      },
    });

    this.logger.debug(`Found ${tools.length} tool(s)`);
    return tools;
  }

  /**
   * Find a single tool by its code
   * Used by ToolExecutorService to validate tool exists before execution
   */
  async findByCode(toolCode: string): Promise<ToolDefinition | null> {
    this.logger.debug(`Finding tool by code: ${toolCode}`);

    const tool = await this.prisma.toolDefinition.findFirst({
      where: {
        toolCode,
        deletedAt: null,
      },
    });

    if (!tool) {
      this.logger.warn(`Tool not found: ${toolCode}`);
    }

    return tool;
  }

  /**
   * Get all active tools
   */
  async findAll(): Promise<ToolDefinition[]> {
    this.logger.debug('Finding all active tools');

    const tools = await this.prisma.toolDefinition.findMany({
      where: {
        deletedAt: null,
      },
      orderBy: {
        toolCode: 'asc',
      },
    });

    this.logger.debug(`Found ${tools.length} active tool(s)`);
    return tools;
  }
}
