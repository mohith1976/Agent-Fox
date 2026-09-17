import { Injectable, Logger } from '@nestjs/common';
import { S3Service } from '../../workflow/storage/s3.service';
import { ExcelService } from '../../workflow/excel/excel.service';
import {
  QueryTransactionsInput,
  QueryTransactionsOutput,
} from '../tool.types';
import { TransactionRow } from '../../workflow/excel/excel.types';

/**
 * query_transactions Tool Implementation
 * Deterministic read, filter, and aggregation
 */
@Injectable()
export class QueryTransactionsImpl {
  private readonly logger = new Logger(QueryTransactionsImpl.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly excelService: ExcelService,
  ) {}

  /**
   * Execute query_transactions
   * Process:
   * 1. Download workbook from S3
   * 2. Load with ExcelJS
   * 3. Read transactions with filters
   * 4. Perform deterministic aggregation
   * 5. Return results
   * @param input - Query input
   * @param s3KeyOverride - Optional S3 key override (for testing)
   */
  async execute(
    input: QueryTransactionsInput,
    s3KeyOverride?: string,
  ): Promise<QueryTransactionsOutput> {
    try {
      this.logger.log('Executing query_transactions');

      // Step 1: Download workbook
      const workbookBuffer = await this.s3Service.downloadWorkbook(
        s3KeyOverride,
      );

      // Step 2: Load workbook
      const workbook = await this.excelService.loadWorkbook(workbookBuffer);

      // Step 3: Read transactions
      const transactions = await this.excelService.readTransactions(
        workbook,
        input.filters,
      );

      // Step 3b: Read authoritative sheet balances when requested
      // ("balance" questions — never derive balances from transaction sums).
      let balances: QueryTransactionsOutput['balances'] = null;
      if (input.includeBalances) {
        balances = await this.excelService.getCurrentBalances(workbook);
      }

      // Step 4: Perform aggregation if requested
      let aggregation: QueryTransactionsOutput['aggregation'];
      if (input.aggregation) {
        aggregation = this.calculateAggregation(
          transactions,
          input.aggregation,
        );
      }

      this.logger.log(
        `Query completed: ${transactions.length} transactions, aggregation=${aggregation ? 'yes' : 'no'}, balances=${balances ? 'yes' : 'no'}`,
      );

      return {
        transactions,
        aggregation,
        balances,
      };
    } catch (error) {
      this.logger.error(
        `query_transactions failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Calculate aggregation (SUM, COUNT, AVERAGE)
   */
  private calculateAggregation(
    transactions: TransactionRow[],
    aggregation: { type: 'SUM' | 'COUNT' | 'AVERAGE'; field: string },
  ): { sum?: number; count: number; average?: number } {
    const count = transactions.length;

    if (aggregation.type === 'COUNT') {
      return { count };
    }

    // Calculate values for SUM/AVERAGE
    const values: number[] = [];

    for (const tx of transactions) {
      let value: number | null = null;
      if (aggregation.field === 'debit') {
        value = tx.debit;
      } else if (aggregation.field === 'credit') {
        value = tx.credit;
      } else if (aggregation.field === 'amount') {
        // 'amount' = debit OR credit (whichever is populated)
        value = tx.debit !== null ? tx.debit : tx.credit;
      }

      // Include the value if it's not null (include 0)
      if (value !== null) {
        values.push(value);
      }
    }

    const sum = values.reduce((acc, val) => acc + val, 0);
    const valueCount = values.length;
    const average = valueCount > 0 ? sum / valueCount : 0;

    if (aggregation.type === 'SUM') {
      return { sum, count: valueCount };
    } else if (aggregation.type === 'AVERAGE') {
      return { average, count: valueCount };
    }

    return { count };
  }
}
