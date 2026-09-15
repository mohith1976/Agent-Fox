import { Injectable, Logger } from '@nestjs/common';
import { S3Service } from '../storage/s3.service';
import { ExcelService } from '../excel/excel.service';
import { WorkbookRulesService } from '../excel/workbook-rules.service';
import { LogTransactionInput, LogTransactionOutput } from './tools.types';
import { NewTransactionInput } from '../excel/excel.types';

/**
 * log_transaction Tool
 * Deterministic transaction persistence to the workbook
 */
@Injectable()
export class LogTransactionTool {
  private readonly logger = new Logger(LogTransactionTool.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly excelService: ExcelService,
    private readonly rulesService: WorkbookRulesService,
  ) {}

  /**
   * Execute log_transaction
   * Process:
   * 1. Download workbook from S3
   * 2. Load with ExcelJS
   * 3. Read TERMINOLOGY for Wishlist
   * 4. Enforce credit/no-color rule
   * 5. Check Wishlist matching
   * 6. Calculate balance
   * 7. Write transaction
   * 8. Validate workbook
   * 9. Upload to S3
   * 10. Return success ONLY after upload succeeds
   * @param input - Transaction input
   * @param s3KeyOverride - Optional S3 key override (for testing)
   */
  async execute(
    input: LogTransactionInput,
    s3KeyOverride?: string,
  ): Promise<LogTransactionOutput> {
    try {
      this.logger.log(
        `Executing log_transaction: ${input.direction} ${input.amount} ${input.mode}`,
      );

      // Validate input
      if (input.amount <= 0) {
        return {
          success: false,
          newBalance: 0,
          insertedRow: 0,
          sheet: '',
          error: 'Amount must be positive',
        };
      }

      // Step 1: Download workbook
      const workbookBuffer = await this.s3Service.downloadWorkbook(
        s3KeyOverride,
      );

      // Step 2: Load workbook
      const workbook = await this.excelService.loadWorkbook(workbookBuffer);

      // Step 3: Read TERMINOLOGY
      const terminology = await this.excelService.readTerminology(workbook);

      // Step 4: Enforce credit/no-color rule
      let finalCategory = input.colourCategory;
      if (input.direction === 'CREDIT') {
        // CRITICAL RULE: Credits never receive category colors
        finalCategory = null;
        this.logger.log('Credit transaction - category color forced to null');
      }

      // Step 5: Check Wishlist matching (if no explicit category)
      if (!finalCategory && input.direction === 'DEBIT') {
        const suggestedCategory =
          this.rulesService.determineCategoryFromDescription(
            input.description,
            terminology.wishlist,
          );
        if (suggestedCategory) {
          finalCategory = suggestedCategory;
          this.logger.log(
            `Wishlist match detected, category set to: ${finalCategory}`,
          );
        }
      }

      // Prepare transaction input
      const txInput: NewTransactionInput = {
        date: input.date,
        description: input.description,
        tag: input.tag,
        mode: input.mode,
        amount: input.amount,
        direction: input.direction,
        colourCategory: finalCategory,
      };

      // Step 7: Write transaction
      const writeResult = await this.excelService.writeTransaction(
        workbook,
        txInput,
      );

      if (!writeResult.success) {
        return writeResult;
      }

      // Step 8: Validate workbook
      const validation = await this.excelService.validateWorkbook(workbook);
      if (!validation.valid) {
        return {
          success: false,
          newBalance: 0,
          insertedRow: 0,
          sheet: '',
          error: `Workbook validation failed: ${validation.errors.join(', ')}`,
        };
      }

      // Step 9: Upload to S3
      const updatedBuffer = await this.excelService.exportWorkbook(workbook);
      await this.s3Service.uploadWorkbook(updatedBuffer, s3KeyOverride);

      // Step 10: Return success ONLY after upload succeeds
      this.logger.log(
        `Transaction logged successfully: Sheet="${writeResult.sheet}", Row=${writeResult.insertedRow}, Balance=${writeResult.newBalance}`,
      );

      return writeResult;
    } catch (error) {
      this.logger.error(
        `log_transaction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        success: false,
        newBalance: 0,
        insertedRow: 0,
        sheet: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
