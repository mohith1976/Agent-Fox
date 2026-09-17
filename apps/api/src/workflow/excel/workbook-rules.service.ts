import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import {
  CategoryColor,
  TransactionDirection,
  WORKBOOK_COLORS,
  WishlistData,
} from './excel.types';

/**
 * Workbook Rules Service
 * Enforces business rules: colors, Wishlist matching, tag extraction
 */
@Injectable()
export class WorkbookRulesService {
  private readonly logger = new Logger(WorkbookRulesService.name);

  /**
   * Apply row color based on direction and category
   * CRITICAL RULE: Credits NEVER receive category colors
   * @param fromCol - First column to color (3/C for month sheets,
   *   2/B for CASH TRACKER whose rows start at the Month column)
   */
  applyRowColor(
    row: ExcelJS.Row,
    direction: TransactionDirection,
    category: CategoryColor | null,
    fromCol: number = 3,
  ): void {
    // Enforce credit no-color rule
    if (direction === 'CREDIT') {
      // Credits receive NO category color
      // Preserve base workbook styling (BASE_FILL if appropriate)
      this.applyBaseFill(row);
      return;
    }

    // Debit with category
    if (direction === 'DEBIT' && category) {
      const color = this.getCategoryColor(category);
      this.applyColorToRow(row, color, fromCol);
    } else {
      // Debit without category - apply base fill or no fill
      this.applyBaseFill(row);
    }
  }

  /**
   * Get ARGB color code for a category
   */
  private getCategoryColor(category: CategoryColor): string {
    if (!category) {
      return '';
    }

    switch (category) {
      case 'AVOID_EXPENSE':
        return WORKBOOK_COLORS.AVOID_EXPENSE;
      case 'PAY_HOME_CASH':
        return WORKBOOK_COLORS.PAY_HOME_CASH;
      case 'PERSONAL_EXPENSE':
        return WORKBOOK_COLORS.PERSONAL_EXPENSE;
      case 'HOME_EXPENSE':
        return WORKBOOK_COLORS.HOME_EXPENSE;
      case 'WISHLIST_EXPENSE':
        return WORKBOOK_COLORS.WISHLIST_EXPENSE;
      default:
        return '';
    }
  }

  /**
   * Apply color fill to all cells in a row (fromCol through I — covers Date,
   * Description, Mode, Debit, Credit, Balances, plus Month on CASH TRACKER)
   */
  private applyColorToRow(
    row: ExcelJS.Row,
    argbColor: string,
    fromCol: number = 3,
  ): void {
    if (!argbColor) {
      return;
    }

    // Apply to relevant columns (through I covers Date, Description, Mode, Debit, Credit, Balances)
    for (let col = fromCol; col <= 9; col++) {
      const cell = row.getCell(col);
      cell.style = {
        ...cell.style,
        fill: {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: argbColor },
        },
      };
    }
  }

  /**
   * Apply base fill (light blue-gray used in CASH TRACKER)
   * Or no fill for neutral transactions
   */
  private applyBaseFill(row: ExcelJS.Row): void {
    // For now, apply no fill (neutral)
    // Could apply BASE_FILL if workbook pattern requires it
    // Base fill application can be refined based on sheet-specific patterns
  }

  /**
   * Detect category color from an existing row
   * Used when reading transactions from workbook
   */
  detectCategoryFromRow(row: ExcelJS.Row): CategoryColor | null {
    // Check date cell (column C) for color
    const dateCell = row.getCell('C');
    const fill = dateCell.style?.fill;

    if (fill && fill.type === 'pattern' && fill.fgColor) {
      const argb =
        'argb' in fill.fgColor ? (fill.fgColor.argb as string) : undefined;

      if (!argb) {
        return null;
      }

      // Match against known category colors
      if (argb === WORKBOOK_COLORS.AVOID_EXPENSE) {
        return 'AVOID_EXPENSE';
      }
      if (argb === WORKBOOK_COLORS.PAY_HOME_CASH) {
        return 'PAY_HOME_CASH';
      }
      if (argb === WORKBOOK_COLORS.PERSONAL_EXPENSE) {
        return 'PERSONAL_EXPENSE';
      }
      if (argb === WORKBOOK_COLORS.HOME_EXPENSE) {
        return 'HOME_EXPENSE';
      }
      if (argb === WORKBOOK_COLORS.WISHLIST_EXPENSE) {
        return 'WISHLIST_EXPENSE';
      }
    }

    return null;
  }

  /**
   * Extract tag from description
   * Tags are bracketed text like [PARTY], [FOOD SPLIT], etc.
   */
  extractTag(description: string): string | null {
    const match = description.match(/\[([^\]]+)\]/);
    return match ? match[1].trim() : null;
  }

  /**
   * Match description against Wishlist items
   * Uses normalized, case-insensitive WORD-BOUNDARY matching
   * Per 03_AGENT_CODING_INSTRUCTIONS.md specification
   */
  matchWishlist(
    description: string,
    wishlistData: WishlistData,
  ): {
    matched: boolean;
    category: 'FOR_HOME' | 'PERSONAL' | 'WISHLIST' | null;
  } {
    // Check WISHLIST category first (most specific)
    for (const item of wishlistData.wishlist) {
      if (this.matchesWordBoundary(description, item)) {
        return { matched: true, category: 'WISHLIST' };
      }
    }

    // Check PERSONAL
    for (const item of wishlistData.personal) {
      if (this.matchesWordBoundary(description, item)) {
        return { matched: true, category: 'PERSONAL' };
      }
    }

    // Check FOR HOME
    for (const item of wishlistData.forHome) {
      if (this.matchesWordBoundary(description, item)) {
        return { matched: true, category: 'FOR_HOME' };
      }
    }

    return { matched: false, category: null };
  }

  /**
   * Word-boundary matching helper
   * Matches term only if it appears as a complete word (not embedded in another word)
   * Case-insensitive, uses regex word boundaries \b
   */
  private matchesWordBoundary(description: string, term: string): boolean {
    // Escape special regex characters in the term
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Create regex with word boundaries, case-insensitive
    const regex = new RegExp(`\\b${escapedTerm}\\b`, 'i');
    
    return regex.test(description);
  }

  /**
   * Determine category based on description and Wishlist
   * Maps EVERY user-defined TERMINOLOGY list to its color, so rows color
   * deterministically even when the LLM suggests no category (suggested
   * null). Case-insensitive word-boundary matching via matchWishlist.
   * Returns suggested category, which can be overridden by explicit input
   * (callers only consult this when no explicit category exists).
   */
  determineCategoryFromDescription(
    description: string,
    wishlistData: WishlistData,
  ): CategoryColor | null {
    const wishlistMatch = this.matchWishlist(description, wishlistData);

    if (wishlistMatch.matched) {
      switch (wishlistMatch.category) {
        case 'WISHLIST':
          return 'WISHLIST_EXPENSE';
        case 'PERSONAL':
          return 'PERSONAL_EXPENSE';
        case 'FOR_HOME':
          return 'HOME_EXPENSE';
        default:
          return null;
      }
    }

    // No automatic category inference for non-listed items
    return null;
  }
}
