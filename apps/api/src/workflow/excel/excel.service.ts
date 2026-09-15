import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import {
  NewTransactionInput,
  TransactionRow,
  TerminologyData,
  TransactionFilters,
  WriteTransactionResult,
  ValidationResult,
  SheetRouting,
  PaymentMode,
  WishlistData,
} from './excel.types';
import { WorkbookRulesService } from './workbook-rules.service';

/**
 * Excel Service for workbook operations using ExcelJS
 */
@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  constructor(private readonly rulesService: WorkbookRulesService) {}

  /**
   * Load workbook from buffer
   */
  async loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    return workbook;
  }

  /**
   * Export workbook to buffer
   */
  async exportWorkbook(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const result = await workbook.xlsx.writeBuffer();
    return Buffer.from(result as ArrayBuffer);
  }

  /**
   * Read TERMINOLOGY sheet configuration
   */
  async readTerminology(workbook: ExcelJS.Workbook): Promise<TerminologyData> {
    const sheet = workbook.getWorksheet('TERMINOLOGY');
    if (!sheet) {
      throw new Error('TERMINOLOGY sheet not found');
    }

    // Read Wishlist entries from rows 15-17, columns 8-10 (H-J)
    const wishlistData: WishlistData = {
      forHome: [],
      personal: [],
      wishlist: [],
    };

    // Row 15: FOR HOME
    const forHomeRow = sheet.getRow(15);
    for (let col = 8; col <= 10; col++) {
      const value = forHomeRow.getCell(col).value;
      if (value && typeof value === 'string' && value.trim() !== '-') {
        wishlistData.forHome.push(value.trim().toUpperCase());
      }
    }

    // Row 16: PERSONAL
    const personalRow = sheet.getRow(16);
    for (let col = 8; col <= 10; col++) {
      const value = personalRow.getCell(col).value;
      if (value && typeof value === 'string' && value.trim() !== '-') {
        wishlistData.personal.push(value.trim().toUpperCase());
      }
    }

    // Row 17: WISHLIST
    const wishlistRow = sheet.getRow(17);
    for (let col = 8; col <= 10; col++) {
      const value = wishlistRow.getCell(col).value;
      if (value && typeof value === 'string' && value.trim() !== '-') {
        wishlistData.wishlist.push(value.trim().toUpperCase());
      }
    }

    this.logger.log(
      `Loaded Wishlist: ForHome=${wishlistData.forHome.length}, Personal=${wishlistData.personal.length}, Wishlist=${wishlistData.wishlist.length}`,
    );

    return { wishlist: wishlistData };
  }

  /**
   * Determine destination sheet and balance column for a payment mode
   */
  determineSheetAndColumn(mode: PaymentMode): SheetRouting {
    const normalizedMode = mode.toUpperCase().replace(/\s+/g, '');

    if (normalizedMode === 'PHONEPAY' || normalizedMode === 'PHONEP AY') {
      return { sheetName: 'SEPTEMBER', balanceColumn: 'H' };
    } else if (normalizedMode === 'WALLET') {
      return { sheetName: 'SEPTEMBER', balanceColumn: 'I' };
    } else if (normalizedMode === 'MONEY') {
      return { sheetName: 'CASH TRACKER', balanceColumn: 'H' };
    } else if (normalizedMode === 'BANK') {
      return { sheetName: 'CASH TRACKER', balanceColumn: 'I' };
    }

    throw new Error(`Unknown payment mode: ${mode}`);
  }

  /**
   * Calculate new balance
   */
  calculateNewBalance(
    currentBalance: number,
    amount: number,
    direction: 'DEBIT' | 'CREDIT',
  ): number {
    if (direction === 'DEBIT') {
      return currentBalance - amount;
    } else {
      return currentBalance + amount;
    }
  }

  /**
   * Find the last populated transaction row and balance for a sheet
   */
  findLastRowAndBalance(
    sheet: ExcelJS.Worksheet,
    sheetName: string,
    balanceColumn: string,
  ): { lastRow: number; currentBalance: number } {
    let headerRow: number;
    let dateColumn: string;

    if (sheetName === 'CASH TRACKER') {
      headerRow = 10;
      dateColumn = 'C';
    } else {
      // Month sheet (SEPTEMBER)
      headerRow = 4;
      dateColumn = 'C';
    }

    let lastRow = headerRow;
    let currentBalance = 0;

    // Scan downward from header to find last populated transaction
    for (let row = headerRow + 1; row <= sheet.rowCount; row++) {
      const dateCell = sheet.getRow(row).getCell(dateColumn);
      const balanceCell = sheet.getRow(row).getCell(balanceColumn);

      if (dateCell.value) {
        lastRow = row;
        // Try to read balance
        const balanceValue = balanceCell.value;
        if (typeof balanceValue === 'number') {
          currentBalance = balanceValue;
        } else if (
          balanceValue &&
          typeof balanceValue === 'object' &&
          'result' in balanceValue
        ) {
          // Formula result
          currentBalance = Number(balanceValue.result) || 0;
        }
      }
    }

    this.logger.log(
      `Sheet "${sheetName}", Column ${balanceColumn}: Last row=${lastRow}, Balance=${currentBalance}`,
    );

    return { lastRow, currentBalance };
  }

  /**
   * Write a new transaction to the workbook
   */
  async writeTransaction(
    workbook: ExcelJS.Workbook,
    tx: NewTransactionInput,
  ): Promise<WriteTransactionResult> {
    try {
      // Determine routing
      const routing = this.determineSheetAndColumn(tx.mode);
      const sheet = workbook.getWorksheet(routing.sheetName);

      if (!sheet) {
        throw new Error(`Sheet "${routing.sheetName}" not found`);
      }

      // Find last row and current balance
      const { lastRow, currentBalance } = this.findLastRowAndBalance(
        sheet,
        routing.sheetName,
        routing.balanceColumn,
      );

      const newRow = lastRow + 1;

      // Calculate new balance
      const newBalance = this.calculateNewBalance(
        currentBalance,
        tx.amount,
        tx.direction,
      );

      // Parse date
      const txDate = typeof tx.date === 'string' ? new Date(tx.date) : tx.date;

      // Prepare row data
      const row = sheet.getRow(newRow);

      if (routing.sheetName === 'CASH TRACKER') {
        // CASH TRACKER format: B=Month, C=Date, D=Description, E=Mode, F=Debit, G=Credit, H=Money, I=Bank
        row.getCell('B').value = txDate.toLocaleString('en-US', {
          month: 'long',
        });
        row.getCell('C').value = txDate;
        row.getCell('D').value = tx.description;
        row.getCell('E').value = tx.mode;
        row.getCell('F').value = tx.direction === 'DEBIT' ? tx.amount : null;
        row.getCell('G').value = tx.direction === 'CREDIT' ? tx.amount : null;
        row.getCell(routing.balanceColumn).value = newBalance;
      } else {
        // Month sheet format: C=Date, D=Description, E=Mode, F=Debit, G=Credit, H=PhnPe, I=Wallet
        row.getCell('C').value = txDate;
        row.getCell('D').value = tx.description;
        row.getCell('E').value = tx.mode;
        row.getCell('F').value = tx.direction === 'DEBIT' ? tx.amount : null;
        row.getCell('G').value = tx.direction === 'CREDIT' ? tx.amount : null;
        row.getCell(routing.balanceColumn).value = newBalance;
      }

      // Apply color rules
      this.rulesService.applyRowColor(row, tx.direction, tx.colourCategory);

      // Commit row
      row.commit();

      // Update monthly summary if month sheet
      if (routing.sheetName !== 'CASH TRACKER') {
        await this.updateMonthlySummary(
          sheet,
          tx.mode,
          routing.balanceColumn,
          newBalance,
        );
      }

      this.logger.log(
        `Transaction written: Sheet="${routing.sheetName}", Row=${newRow}, Balance=${newBalance}`,
      );

      return {
        success: true,
        newBalance,
        insertedRow: newRow,
        sheet: routing.sheetName,
      };
    } catch (error) {
      this.logger.error(`Write transaction failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        success: false,
        newBalance: 0,
        insertedRow: 0,
        sheet: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Update monthly summary
   * SEPTEMBER structure: Row 7 = WALLET (Col L), Row 8 = PHNPE (Col L)
   */
  private async updateMonthlySummary(
    sheet: ExcelJS.Worksheet,
    mode: PaymentMode,
    balanceColumn: string,
    newBalance: number,
  ): Promise<void> {
    const normalizedMode = mode.toUpperCase().replace(/\s+/g, '');

    let summaryRow: number;
    if (
      normalizedMode === 'PHONEPAY' ||
      normalizedMode === 'PHONEPAY' ||
      balanceColumn === 'H'
    ) {
      summaryRow = 8; // PHNPE
    } else if (normalizedMode === 'WALLET' || balanceColumn === 'I') {
      summaryRow = 7; // WALLET
    } else {
      return; // No summary update needed
    }

    const summaryCell = sheet.getRow(summaryRow).getCell('L');
    summaryCell.value = newBalance;

    this.logger.log(`Updated monthly summary: Row ${summaryRow} = ${newBalance}`);
  }

  /**
   * Read transactions from workbook with optional filters
   */
  async readTransactions(
    workbook: ExcelJS.Workbook,
    filters?: TransactionFilters,
  ): Promise<TransactionRow[]> {
    const transactions: TransactionRow[] = [];

    const sheetsToRead =
      filters?.sheets && filters.sheets.length > 0
        ? filters.sheets
        : ['SEPTEMBER', 'CASH TRACKER'];

    for (const sheetName of sheetsToRead) {
      const sheet = workbook.getWorksheet(sheetName);
      if (!sheet) {
        this.logger.warn(`Sheet "${sheetName}" not found, skipping`);
        continue;
      }

      const sheetTransactions = this.readTransactionsFromSheet(
        sheet,
        sheetName,
        filters,
      );
      transactions.push(...sheetTransactions);
    }

    this.logger.log(`Read ${transactions.length} transactions`);
    return transactions;
  }

  private readTransactionsFromSheet(
    sheet: ExcelJS.Worksheet,
    sheetName: string,
    filters?: TransactionFilters,
  ): TransactionRow[] {
    const transactions: TransactionRow[] = [];

    let headerRow: number;
    let startRow: number;

    if (sheetName === 'CASH TRACKER') {
      headerRow = 10;
      startRow = 11;
    } else {
      headerRow = 4;
      startRow = 5;
    }

    for (let rowNum = startRow; rowNum <= sheet.rowCount; rowNum++) {
      const row = sheet.getRow(rowNum);
      const dateCell = row.getCell('C');

      if (!dateCell.value) {
        continue; // Empty row
      }

      const date =
        dateCell.value instanceof Date
          ? dateCell.value
          : new Date(String(dateCell.value));
      const description = String(row.getCell('D').value || '');
      const mode = String(row.getCell('E').value || '') as PaymentMode;
      const debit = this.getCellNumber(row.getCell('F'));
      const credit = this.getCellNumber(row.getCell('G'));

      // Determine balance column
      let balance = 0;
      if (sheetName === 'CASH TRACKER') {
        // Money = H, Bank = I
        const modeUpper = mode.toUpperCase();
        if (modeUpper === 'MONEY') {
          balance = this.getCellNumber(row.getCell('H'));
        } else if (modeUpper === 'BANK') {
          balance = this.getCellNumber(row.getCell('I'));
        }
      } else {
        // PhonePay = H, Wallet = I
        const modeNorm = mode.toUpperCase().replace(/\s+/g, '');
        if (modeNorm === 'PHONEPAY' || modeNorm === 'PHONEPAY') {
          balance = this.getCellNumber(row.getCell('H'));
        } else if (modeNorm === 'WALLET') {
          balance = this.getCellNumber(row.getCell('I'));
        }
      }

      const category = this.rulesService.detectCategoryFromRow(row);
      const tag = this.rulesService.extractTag(description);

      const transaction: TransactionRow = {
        sheet: sheetName,
        row: rowNum,
        date,
        description,
        mode,
        debit,
        credit,
        balance,
        colourCategory: category,
        tag,
      };

      // Apply filters
      if (this.matchesFilters(transaction, filters)) {
        transactions.push(transaction);
      }
    }

    return transactions;
  }

  private getCellNumber(cell: ExcelJS.Cell): number {
    const value = cell.value;
    if (typeof value === 'number') {
      return value;
    }
    if (value && typeof value === 'object' && 'result' in value) {
      return Number(value.result) || 0;
    }
    return 0;
  }

  private matchesFilters(
    tx: TransactionRow,
    filters?: TransactionFilters,
  ): boolean {
    if (!filters) {
      return true;
    }

    if (
      filters.modes &&
      filters.modes.length > 0 &&
      !filters.modes.includes(tx.mode)
    ) {
      return false;
    }

    if (
      filters.categories &&
      filters.categories.length > 0 &&
      !filters.categories.includes(tx.colourCategory)
    ) {
      return false;
    }

    if (filters.dateFrom && tx.date < new Date(filters.dateFrom)) {
      return false;
    }

    if (filters.dateTo && tx.date > new Date(filters.dateTo)) {
      return false;
    }

    if (
      filters.descriptionContains &&
      !tx.description
        .toLowerCase()
        .includes(filters.descriptionContains.toLowerCase())
    ) {
      return false;
    }

    if (filters.tags && filters.tags.length > 0 && tx.tag) {
      const hasMatchingTag = filters.tags.some(
        (filterTag) =>
          tx.tag?.toLowerCase().includes(filterTag.toLowerCase()) ?? false,
      );
      if (!hasMatchingTag) {
        return false;
      }
    }

    return true;
  }

  /**
   * Validate workbook structure
   */
  async validateWorkbook(workbook: ExcelJS.Workbook): Promise<ValidationResult> {
    const errors: string[] = [];

    // Check required sheets exist
    const requiredSheets = ['TERMINOLOGY', 'CASH TRACKER', 'SEPTEMBER'];
    for (const sheetName of requiredSheets) {
      if (!workbook.getWorksheet(sheetName)) {
        errors.push(`Required sheet "${sheetName}" not found`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
