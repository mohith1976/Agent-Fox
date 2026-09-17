/**
 * log_transaction Tool Implementation
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
import * as crypto from 'crypto';
import { S3Service } from '../../workflow/storage/s3.service';
import { ExcelService } from '../../workflow/excel/excel.service';
import { WorkbookRulesService } from '../../workflow/excel/workbook-rules.service';
import { LogTransactionInput, LogTransactionOutput } from '../tool.types';
import { NewTransactionInput } from '../../workflow/excel/excel.types';
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
export class LogTransactionImpl {
  private readonly logger = new Logger(LogTransactionImpl.name);

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
      // STEP 1: Download workbook ONCE, capturing the base-version ETag
      // BEFORE any mutation (compare-and-swap precondition for the upload).
      this.logger.log(`[BATCH_TOOL] STEP 1 - Downloading workbook from S3, key=${s3KeyOverride || 'default'}`);
      const { buffer: workbookBuffer, etag: baseVersionETag } =
        await this.s3Service.downloadWithMetadata(s3KeyOverride);
      this.logger.log(`[BATCH_TOOL] STEP 1 - Downloaded ${workbookBuffer.length} bytes (base ETag=${baseVersionETag})`);

      // STEP 2: Load workbook
      this.logger.log(`[BATCH_TOOL] STEP 2 - Loading workbook`);
      const workbook = await this.excelService.loadWorkbook(workbookBuffer);
      this.logger.log(`[BATCH_TOOL] STEP 2 - Workbook loaded successfully`);

      // STEP 3: Read TERMINOLOGY (needed for Wishlist)
      this.logger.log(`[BATCH_TOOL] STEP 3 - Reading terminology`);
      const terminology = await this.excelService.readTerminology(workbook);
      this.logger.log(`[BATCH_TOOL] STEP 3 - Terminology loaded`);

      // STEP 3b: Sufficient-balance guard — a debit batch must never drive a
      // mode balance negative. Project per mode from the sheet's own balance
      // cards (current + batch credits − batch debits) and refuse with a
      // plain-language message when any mode would go below zero. Modes with
      // no recorded balance are skipped (fail-open, never block). Refusal
      // happens BEFORE any in-memory mutation, so nothing is persisted and
      // the caller keeps the batch for edit/cancel.
      this.logger.log(`[BATCH_TOOL] STEP 3b - Checking sufficient balances`);
      const balances = await this.excelService.getCurrentBalances(workbook);
      const netByMode: Record<string, number> = {};
      for (const tx of input.transactions) {
        const mode = String(tx.mode || '').toUpperCase();
        const amt = Number(tx.amount) || 0;
        netByMode[mode] =
          (netByMode[mode] || 0) + (tx.direction === 'CREDIT' ? amt : -amt);
      }
      const shortfalls: string[] = [];
      for (const [mode, net] of Object.entries(netByMode)) {
        const current = (balances as unknown as Record<string, number | null>)[mode];
        if (current === null || current === undefined) continue;
        const projected = current + net;
        if (projected < 0) {
          const debitTotal = input.transactions
            .filter(
              (tx) =>
                String(tx.mode || '').toUpperCase() === mode &&
                tx.direction !== 'CREDIT',
            )
            .reduce((s, tx) => s + (Number(tx.amount) || 0), 0);
          shortfalls.push(
            `You have only ₹${current.toLocaleString('en-IN')} in ${mode} — this debit of ₹${debitTotal.toLocaleString('en-IN')} would take it to ₹${projected.toLocaleString('en-IN')}. Add a credit to ${mode} first, or pay from a different mode.`,
          );
        }
      }
      if (shortfalls.length > 0) {
        const refusal = `${shortfalls.join(' ')} Your batch is kept — edit it (e.g. "change item 1 mode to bank") or cancel.`;
        this.logger.warn(`[BATCH_TOOL] Batch refused: insufficient balance`);
        return { success: false, results: [], error: refusal };
      }

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

      // STEP 6: Conditional upload ONCE (compare-and-swap).
      // Succeeds only if the workbook still has baseVersionETag — a concurrent
      // writer wins, we get PreconditionFailed/ConditionalRequestConflict and
      // MUST NOT retry blindly (our in-memory mutation is based on stale data).
      this.logger.log(`[BATCH_TOOL] STEP 6 - Exporting workbook to buffer`);
      const updatedBuffer = await this.excelService.exportWorkbook(workbook);
      this.logger.log(`[BATCH_TOOL] STEP 6 - Exported ${updatedBuffer.length} bytes`);

      // Expected ETag of our new content (S3 ETags are quoted MD5 for simple PUTs).
      // Used to verify commit status if the upload times out mid-flight.
      const expectedETag = `"${crypto.createHash('md5').update(updatedBuffer).digest('hex')}"`;

      this.logger.log(`[BATCH_TOOL] STEP 6 - Conditional upload to S3, key=${s3KeyOverride || 'default'}, IfMatch=${baseVersionETag}`);
      try {
        await this.s3Service.uploadConditional(
          updatedBuffer,
          { ifMatch: baseVersionETag },
          s3KeyOverride,
        );
        this.logger.log(`[BATCH_TOOL] STEP 6 - Upload successful`);
      } catch (uploadError) {
        const code = (uploadError as { code?: string })?.code;
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);

        // 412/409: another writer committed first. Fail safely — caller must
        // retry with a fresh download, never with this stale mutation.
        if (code === 'PreconditionFailed' || code === 'ConditionalRequestConflict') {
          this.logger.error(`[BATCH_TOOL] Batch write REJECTED by S3 concurrency guard: ${message}`);
          return {
            success: false,
            results,
            error: message,
          };
        }

        // Timeout: unknown commit state. Verify via ETag comparison whether
        // OUR version reached S3 before deciding committed vs failed.
        if (code === 'S3_UPLOAD_TIMEOUT') {
          const currentETag = await this.s3Service.headETag(s3KeyOverride);
          if (currentETag === expectedETag) {
            this.logger.log('[BATCH_TOOL] Upload timed out but ETag proves our version committed');
            return { success: true, results };
          }
          this.logger.error('[BATCH_TOOL] Upload timeout, commit status unverifiable — failing safely');
          return {
            success: false,
            results,
            error: message,
          };
        }

        // Other S3 errors — fail the batch, no partial state was persisted.
        this.logger.error(`[BATCH_TOOL] Batch write FAILED: S3 upload error: ${message}`);

        return {
          success: false,
          results,
          error: `S3 upload failed: ${message}`,
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
      // Description is uppercased (idempotent) — the book convention is
      // all-caps; the graph already normalizes, this is the backstop.
      const txInput: NewTransactionInput = {
        date: input.date,
        description: String(input.description || '').trim().toUpperCase(),
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
