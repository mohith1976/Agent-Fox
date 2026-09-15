import { Module } from '@nestjs/common';
import { LogTransactionTool } from './log-transaction.tool';
import { LogTransactionBatchTool } from './log-transaction-batch.tool';
import { QueryTransactionsTool } from './query-transactions.tool';
import { GenerateChartTool } from './generate-chart.tool';
import { StorageModule } from '../storage/storage.module';
import { ExcelModule } from '../excel/excel.module';

@Module({
  imports: [StorageModule, ExcelModule],
  providers: [
    LogTransactionTool,
    LogTransactionBatchTool,
    QueryTransactionsTool,
    GenerateChartTool,
  ],
  exports: [
    LogTransactionTool,
    LogTransactionBatchTool,
    QueryTransactionsTool,
    GenerateChartTool,
  ],
})
export class ToolsModule {}
