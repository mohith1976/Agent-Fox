/**
 * log_transaction_batch Tool
 * 
 * ATOMIC BATCH WRITE:
 * 1. Download workbook once
 * 2. Apply ALL transactions deterministically in memory
 * 3. Validate complete mutation
 * 4. Upload workbook once
 * 5. Return success ONLY after upload succeeds
 * 
 * CRITICAL: Prevents duplicate writes on retry.
 * If item 1 and 2 succeed but item 3 fails during upload,
 * the ENTIRE batch is rolled back. No partial writes to S3.
 */

import { Injectable, Logger } from '@nestjs/common';
import { S3Service } from '../storage/s3.service';
import { ExcelService } from '../excel/excel.service';
import { WorkbookRulesService } from '../excel/workbook-rules.service';
import { LogTransactionInput, LogTransactionOutput } from './tools.types';
import { NewTransactionInput } from '../excel/excel.types';
import { Workbook } from 'exceljs';

export interface BatchTransactionInput {
  transactions: LogTransactionInput[];
}

export interface BatchTransactionOutput {
  success: boolean;
  results: LogTransactionOutput[];
  error?: string;
}

@Injectable()
export class LogTransactionBatchTool {
  private readonly logger = new Logger(LogTransactionBatchTool.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly excelService: ExcelService,
    private readonly rulesService: WorkbookRulesService,
  ) {}

  /**
   * Execute batch transaction write
   * 
   * ATOMICITY GUARANTEE:
   * - Either ALL transactions are written to S3, or NONE are
   * - Partial failures do NOT result in partial S3 state
   * - Safe to retry: idempotent at the S3 level
   */
  async execute(
    input: BatchTransactionInput,
    s3KeyOverride?: string,
  ): Promise<BatchTransactionOutput> {
    this.logger.log(`[BATCH_TOOL] DEBUG START - ${input.transactions?.length || 0} transactions`);
    
    if (!input.transactions || input.transactions.length === 0) {
      this.logger.error(`[BATCH_TOOL] ERROR - No transactions provided`);
      return {
        success: false,
        results: [],
        error: 'No transactions provided',
      };
    }

    this.logger.log(
      `[BATCH_TOOL] Executing batch write: ${input.transactions.length} transaction(s)`,
    );
    
    this.logger.log(`[BATCH_TOOL] DEBUG - Transactions: ${JSON.stringify(input.transactions.map(tx => ({
      date: tx.date,
      description: tx.description,
      amount: tx.amount,
      direction: tx.direction
    })))}`);

    try {
      // STEP 1: Download workbook ONCE
      this.logger.log(`[BATCH_TOOL] STEP 1 - Downloading workbook from S3, key=${s3KeyOverride || 'default'}`);
      const workbookBuffer = await this.s3Service.downloadWorkbook(
        s3KeyOverride,
      );
      this.logger.log(`[BATCH_TOOL] STEP 1 - Downloaded ${workbookBuffer.length} bytes`);

      // STEP 2: Load workbook
      this.logger.log(`[BATCH_TOOL] STEP 2 - Loading workbook`);
      const workbook = await this.excelService.loadWorkbook(workbookBuffer);
      this.logger.log(`[BATCH_TOOL] STEP 2 - Workbook loaded successfully`);

      // STEP 3: Read TERMINOLOGY (needed for Wishlist)
      this.logger.log(`[BATCH_TOOL] STEP 3 - Reading terminology`);
      const terminology = await this.excelService.readTerminology(workbook);
      this.logger.log(`[BATCH_TOOL] STEP 3 - Terminology loaded`);

      // STEP 4: Apply ALL transactions deterministically in memory
      this.logger.log(`[BATCH_TOOL] STEP 4 - Applying ${input.transactions.length} transactions to workbook`);
      const results: LogTransactionOutput[] = [];

      for (let i = 0; i < input.transactions.length; i++) {
        const txInput = input.transactions[i];
        this.logger.log(`[BATCH_TOOL] STEP 4.${i + 1} - Applying transaction: ${txInput.description}`);
        
        const result = await this.applyTransactionToWorkbook(
          workbook,
          txInput,
          terminology,
        );
        
        this.logger.log(`[BATCH_TOOL] STEP 4.${i + 1} - Result: success=${result.success}, newBalance=${result.newBalance}, error=${result.error}`);

        results.push(result);

        if (!result.success) {
          // CRITICAL: If any transaction fails validation/application,
          // abort the entire batch WITHOUT uploading
          this.logger.error(
            `[BATCH_TOOL] Batch write aborted: transaction "${txInput.description}" failed: ${result.error}`,
          );

          return {
            success: false,
            results,
            error: `Transaction "${txInput.description}" failed: ${result.error}`,
          };
        }
      }
      
      this.logger.log(`[BATCH_TOOL] STEP 4 - All transactions applied successfully`);

      // STEP 5: Validate workbook structure
      this.logger.log(`[BATCH_TOOL] STEP 5 - Validating workbook structure`);
      const validation = await this.excelService.validateWorkbook(workbook);
      this.logger.log(`[BATCH_TOOL] STEP 5 - Validation result: valid=${validation.valid}, errors=${validation.errors?.length || 0}`);
      
      if (!validation.valid) {
        this.logger.error(
          `[BATCH_TOOL] Batch write aborted: workbook validation failed: ${validation.errors.join(', ')}`,
        );

        return {
          success: false,
          results,
          error: `Workbook validation failed: ${validation.errors.join(', ')}`,
        };
      }

      // STEP 6: Upload workbook ONCE
      this.logger.log(`[BATCH_TOOL] STEP 6 - Exporting workbook to buffer`);
      const updatedBuffer = await this.excelService.exportWorkbook(workbook);
      this.logger.log(`[BATCH_TOOL] STEP 6 - Exported ${updatedBuffer.length} bytes`);

      this.logger.log(`[BATCH_TOOL] STEP 6 - Uploading to S3, key=${s3KeyOverride || 'default'}`);
      try {
        await this.s3Service.uploadWorkbook(updatedBuffer, s3KeyOverride);
        this.logger.log(`[BATCH_TOOL] STEP 6 - Upload successful`);
      } catch (uploadError) {
        // CRITICAL: S3 upload failed - entire batch failed
        this.logger.error(
          `[BATCH_TOOL] Batch write FAILED: S3 upload error: ${uploadError}`,
        );
        this.logger.error(`[BATCH_TOOL] Upload error stack: ${uploadError instanceof Error ? uploadError.stack : 'N/A'}`);

        return {
          success: false,
          results,
          error: `S3 upload failed: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
        };
      }

      // STEP 7: Return success ONLY after upload succeeds
      this.logger.log(
        `[BATCH_TOOL] Batch write SUCCESS: ${input.transactions.length} transaction(s) persisted to S3`,
      );

      return {
        success: true,
        results,
      };
    } catch (error) {
      this.logger.error(
        `[BATCH_TOOL] EXCEPTION: ${error instanceof Error ? error.name : typeof error}`,
      );
      this.logger.error(
        `[BATCH_TOOL] EXCEPTION MESSAGE: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.logger.error(
        `[BATCH_TOOL] EXCEPTION STACK: ${error instanceof Error ? error.stack : 'N/A'}`,
      );

      return {
        success: false,
        results: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Apply a single transaction to the workbook in memory
   * Does NOT upload - workbook mutation only
   */
  private async applyTransactionToWorkbook(
    workbook: Workbook,
    input: LogTransactionInput,
    terminology: any,
  ): Promise<LogTransactionOutput> {
    try {
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

      // Enforce credit/no-color rule
      let finalCategory = input.colourCategory;
      if (input.direction === 'CREDIT') {
        // CRITICAL RULE: Credits never receive category colors
        finalCategory = null;
        this.logger.log('Credit transaction - category color forced to null');
      }

      // Check Wishlist matching (if no explicit category)
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

      // Write transaction to workbook (in memory)
      const writeResult = await this.excelService.writeTransaction(
        workbook,
        txInput,
      );

      return writeResult;
    } catch (error) {
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
