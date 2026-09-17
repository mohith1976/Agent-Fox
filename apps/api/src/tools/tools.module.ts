/**
 * Tools Module
 * 
 * DB-driven tools infrastructure:
 * - ToolRegistryService: Loads tool definitions from database
 * - ToolExecutorService: Routes tool_code to implementation
 * - Tool Implementations: log_transaction, query_transactions, generate_chart
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../workflow/storage/storage.module';
import { ExcelService } from '../workflow/excel/excel.service';
import { WorkbookRulesService } from '../workflow/excel/workbook-rules.service';

import { ToolRegistryService } from './tool-registry.service';
import { ToolExecutorService } from './tool-executor.service';
import { LogTransactionImpl } from './implementations/log-transaction.impl';
import { QueryTransactionsImpl } from './implementations/query-transactions.impl';
import { GenerateChartImpl } from './implementations/generate-chart.impl';

@Module({
  imports: [
    DatabaseModule,
    StorageModule, // Provides S3Service
  ],
  providers: [
    // Excel services (needed by tool implementations)
    ExcelService,
    WorkbookRulesService,

    // Tool registry and executor
    ToolRegistryService,
    ToolExecutorService,

    // Tool implementations
    LogTransactionImpl,
    QueryTransactionsImpl,
    GenerateChartImpl,
  ],
  exports: [
    ToolRegistryService,
    ToolExecutorService,
  ],
})
export class ToolsModule {}
