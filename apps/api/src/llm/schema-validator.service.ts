import { Injectable, Logger } from '@nestjs/common';
import {
  ValidationResult,
  ExtractedTransaction,
  ColourCategory,
  PaymentMode,
  TransactionDirection,
} from './llm.types';

/**
 * Schema Validator
 * Validates LLM structured outputs before passing to deterministic tools
 */
@Injectable()
export class SchemaValidator {
  private readonly logger = new Logger(SchemaValidator.name);

  private readonly validModes: PaymentMode[] = [
    'PHONEPAY',
    'WALLET',
    'MONEY',
    'BANK',
  ];

  private readonly validDirections: TransactionDirection[] = ['DEBIT', 'CREDIT'];

  private readonly validCategories: ColourCategory[] = [
    'AVOID_EXPENSE',
    'PAY_HOME_CASH',
    'PERSONAL_EXPENSE',
    'HOME_EXPENSE',
    'WISHLIST_EXPENSE',
    null,
  ];

  /**
   * Validate a single extracted transaction
   * @param transaction - Transaction to validate
   * @returns Validation result
   */
  validateTransaction(
    transaction: ExtractedTransaction,
  ): ValidationResult {
    const errors: string[] = [];

    // Validate date format (YYYY-MM-DD)
    if (!transaction.date || !/^\d{4}-\d{2}-\d{2}$/.test(transaction.date)) {
      errors.push(
        `Invalid date format: ${transaction.date}. Expected YYYY-MM-DD`,
      );
    }

    // Validate date is not in future
    const txDate = new Date(transaction.date);
    const today = new Date();
    today.setHours(23, 59, 59, 999); // End of today
    if (txDate > today) {
      errors.push(`Date cannot be in the future: ${transaction.date}`);
    }

    // Validate description
    if (!transaction.description || transaction.description.trim().length === 0) {
      errors.push('Description cannot be empty');
    }

    // Validate mode
    if (!this.validModes.includes(transaction.mode)) {
      errors.push(
        `Invalid mode: ${transaction.mode}. Must be one of: ${this.validModes.join(', ')}`,
      );
    }

    // Validate amount
    if (
      typeof transaction.amount !== 'number' ||
      transaction.amount <= 0 ||
      !isFinite(transaction.amount)
    ) {
      errors.push(
        `Invalid amount: ${transaction.amount}. Must be a positive number`,
      );
    }

    // Validate direction
    if (!this.validDirections.includes(transaction.direction)) {
      errors.push(
        `Invalid direction: ${transaction.direction}. Must be DEBIT or CREDIT`,
      );
    }

    // Validate category
    if (!this.validCategories.includes(transaction.suggestedCategory)) {
      errors.push(
        `Invalid category: ${transaction.suggestedCategory}. Must be one of: ${this.validCategories.filter((c) => c !== null).join(', ')} or null`,
      );
    }

    // CRITICAL: Validate credit transactions have no category
    if (
      transaction.direction === 'CREDIT' &&
      transaction.suggestedCategory !== null
    ) {
      errors.push('CRITICAL: Credit transactions must not have a category');
    }

    if (errors.length > 0) {
      this.logger.warn(
        `Transaction validation failed: ${errors.join('; ')}`,
      );
      return {
        valid: false,
        errors,
      };
    }

    return {
      valid: true,
      errors: [],
    };
  }

  /**
   * Validate a batch of transactions
   * @param transactions - Transactions to validate
   * @returns Validation result
   */
  validateTransactionBatch(
    transactions: ExtractedTransaction[],
  ): ValidationResult {
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return {
        valid: false,
        errors: ['Transaction batch cannot be empty'],
      };
    }

    const allErrors: string[] = [];

    transactions.forEach((tx, index) => {
      const result = this.validateTransaction(tx);
      if (!result.valid) {
        allErrors.push(
          `Transaction ${index + 1}: ${result.errors.join('; ')}`,
        );
      }
    });

    if (allErrors.length > 0) {
      this.logger.warn(
        `Batch validation failed: ${allErrors.length} error(s)`,
      );
      return {
        valid: false,
        errors: allErrors,
      };
    }

    this.logger.log(
      `Batch validation passed: ${transactions.length} transaction(s)`,
    );

    return {
      valid: true,
      errors: [],
    };
  }

  /**
   * Validate category value
   * @param category - Category to validate
   * @returns Validation result
   */
  validateCategory(category: ColourCategory): ValidationResult {
    if (!this.validCategories.includes(category)) {
      return {
        valid: false,
        errors: [
          `Invalid category: ${category}. Must be one of: ${this.validCategories.filter((c) => c !== null).join(', ')} or null`,
        ],
      };
    }

    return {
      valid: true,
      errors: [],
    };
  }

  /**
   * Validate payment mode
   * @param mode - Mode to validate
   * @returns Validation result
   */
  validateMode(mode: PaymentMode): ValidationResult {
    if (!this.validModes.includes(mode)) {
      return {
        valid: false,
        errors: [
          `Invalid mode: ${mode}. Must be one of: ${this.validModes.join(', ')}`,
        ],
      };
    }

    return {
      valid: true,
      errors: [],
    };
  }
}
