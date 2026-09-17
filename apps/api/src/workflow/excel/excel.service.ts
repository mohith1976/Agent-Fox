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
  SheetBalances,
  PaymentMode,
  WishlistData,
} from './excel.types';
import { WorkbookRulesService } from './workbook-rules.service';

/**
 * Normalize a payment-mode label for comparison/grouping.
 * Real books store variants ("Phone Pay", "PHONEPAY", blank) — all map to
 * one canonical key so filters and breakdowns never split or drop rows.
 * Blank/unknown becomes 'UNSPECIFIED' (shown honestly, not hidden).
 */
export function normalizeModeLabel(mode: unknown): string {
  const normalized = String(mode || '')
    .toUpperCase()
    .replace(/[\s_-]+/g, '');
  return normalized || 'UNSPECIFIED';
}

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

      // Book convention is all-caps descriptions — normalize at the choke
      // point so EVERY write path (current and future) lands caps in the sheet.
      const sheetDescription = String(tx.description || '').trim().toUpperCase();

      if (routing.sheetName === 'CASH TRACKER') {
        // CASH TRACKER format: B=Month, C=Date, D=Description, E=Mode, F=Debit, G=Credit, H=Money, I=Bank
        row.getCell('B').value = txDate.toLocaleString('en-US', {
          month: 'long',
        });
        row.getCell('C').value = txDate;
        row.getCell('D').value = sheetDescription;
        row.getCell('E').value = tx.mode;
        row.getCell('F').value = tx.direction === 'DEBIT' ? tx.amount : null;
        row.getCell('G').value = tx.direction === 'CREDIT' ? tx.amount : null;
        row.getCell(routing.balanceColumn).value = newBalance;
      } else {
        // Month sheet format: C=Date, D=Description, E=Mode, F=Debit, G=Credit, H=PhnPe, I=Wallet
        row.getCell('C').value = txDate;
        row.getCell('D').value = sheetDescription;
        row.getCell('E').value = tx.mode;
        row.getCell('F').value = tx.direction === 'DEBIT' ? tx.amount : null;
        row.getCell('G').value = tx.direction === 'CREDIT' ? tx.amount : null;
        row.getCell(routing.balanceColumn).value = newBalance;
      }

      // Apply color rules (CASH TRACKER rows start at B/Month — color it too)
      this.rulesService.applyRowColor(
        row,
        tx.direction,
        tx.colourCategory,
        routing.sheetName === 'CASH TRACKER' ? 2 : 3,
      );

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
      } else {
        // CASH TRACKER top cards (BANK/MONEY) + TERMINOLOGY CURR cards must
        // move with every write — they are what "balance" questions read.
        this.updateLabeledCard(sheet, tx.mode, newBalance);
        const terminology = workbook.getWorksheet('TERMINOLOGY');
        if (terminology) {
          this.updateLabeledCard(terminology, `${tx.mode}[CURR]`, newBalance);
        }
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
   * Update a labeled balance card: find a cell whose text matches the label
   * (e.g. "BANK", "MONEY", "BANK[CURR]") in the label zone and write the new
   * balance into the cell immediately to its right.
   *
   * Covers CASH TRACKER top cards (C5/D5 BANK, C6/D6 MONEY) and TERMINOLOGY
   * CURR cards (J5/K5 BANK[CURR], J6/K6 MONEY[CURR]).
   */
  private updateLabeledCard(
    sheet: ExcelJS.Worksheet,
    label: string,
    newBalance: number,
  ): void {
    const wanted = label.toUpperCase().replace(/\s+/g, '');
    const maxRow = Math.min(12, sheet.rowCount);
    const maxCol = Math.min(16, sheet.columnCount);

    for (let row = 1; row <= maxRow; row++) {
      for (let col = 1; col <= maxCol; col++) {
        const v = sheet.getRow(row).getCell(col).value;
        if (typeof v !== 'string') continue;
        if (v.toUpperCase().replace(/\s+/g, '') !== wanted) continue;
        sheet.getRow(row).getCell(col + 1).value = newBalance;
        this.logger.log(
          `Updated balance card "${v}" at ${sheet.getColumn(col).letter}${row} = ${newBalance}`,
        );
        return;
      }
    }

    this.logger.warn(
      `Balance card "${label}" not found on sheet "${sheet.name}" — card not updated`,
    );
  }

  /**
   * Resolve LLM-requested sheet names to actual workbook sheets.
   */
  private resolveSheetNames(
    workbook: ExcelJS.Workbook,
    requested?: string[],
  ): string[] {
    const defaults = ['SEPTEMBER', 'CASH TRACKER'];

    if (!requested || requested.length === 0) {
      return defaults.filter((s) => workbook.getWorksheet(s));
    }

    const actual = workbook.worksheets.map((s) => s.name);
    const resolved: string[] = [];

    for (const name of requested) {
      const cleaned = name.replace(/\s*\(.*\)\s*$/, '').trim();
      const hit = actual.find(
        (a) =>
          a.toUpperCase() === cleaned.toUpperCase() ||
          a.toUpperCase() === name.toUpperCase(),
      );
      if (hit) {
        if (!resolved.includes(hit)) resolved.push(hit);
      } else {
        this.logger.warn(
          `Requested sheet "${name}" does not exist (have: ${actual.join(', ')}) — skipping`,
        );
      }
    }

    if (resolved.length === 0) {
      this.logger.warn(
        'No requested sheets resolved — falling back to default sheets',
      );
      return defaults.filter((s) => workbook.getWorksheet(s));
    }

    return resolved;
  }

  /**
   * Read current balances from the workbook itself.
   *
   * Rule (per the owner's bookkeeping): each mode's current balance is the
   * LAST recorded running-balance value in its column — H for PhonePay (month
   * sheets) / Money (CASH TRACKER), I for Wallet / Bank. The "current" month
   * sheet is the one with the latest last-transaction date.
   *
   * This is the AUTHORITATIVE source for "balance" questions. Summing
   * transactions is NOT equivalent (opening balances live outside the rows).
   */
  async getCurrentBalances(
    workbook: ExcelJS.Workbook,
  ): Promise<SheetBalances> {
    const isAux = (name: string) =>
      ['TERMINOLOGY', 'CASH TRACKER'].includes(name.toUpperCase());

    let phonepay: number | null = null;
    let wallet: number | null = null;
    let latestMonthTime = -Infinity;

    for (const sheet of workbook.worksheets) {
      if (isAux(sheet.name)) continue;
      // Month sheets: header row 4, C=Date, H=PhnPe Bal, I=Wallet Bal
      const last = this.findLastDatedRow(sheet, 4, 'C');
      if (!last) continue;
      if (last.date.getTime() > latestMonthTime) {
        latestMonthTime = last.date.getTime();
        phonepay = this.lastNumericInColumn(sheet, 5, last.row, 'H');
        wallet = this.lastNumericInColumn(sheet, 5, last.row, 'I');
      }
    }

    const cash = workbook.getWorksheet('CASH TRACKER');
    let money: number | null = null;
    let bank: number | null = null;
    if (cash) {
      const last = this.findLastDatedRow(cash, 10, 'C');
      if (last) {
        money = this.lastNumericInColumn(cash, 11, last.row, 'H');
        bank = this.lastNumericInColumn(cash, 11, last.row, 'I');
      }
    }

    const balances = { PHONEPAY: phonepay, WALLET: wallet, MONEY: money, BANK: bank };
    this.logger.log(`Current sheet balances: ${JSON.stringify(balances)}`);
    return balances;
  }

  /**
   * Last dated row at/below headerRow (date in dateColumn), or null.
   */
  private findLastDatedRow(
    sheet: ExcelJS.Worksheet,
    headerRow: number,
    dateColumn: string,
  ): { row: number; date: Date } | null {
    let found: { row: number; date: Date } | null = null;
    for (let row = headerRow + 1; row <= sheet.rowCount; row++) {
      const v = sheet.getRow(row).getCell(dateColumn).value;
      if (!v) continue;
      const d = v instanceof Date ? v : new Date(String(v));
      if (isNaN(d.getTime())) continue;
      found = { row, date: d };
    }
    return found;
  }

  /**
   * Last numeric value in column at/below fromRow scanning upward, or null.
   */
  private lastNumericInColumn(
    sheet: ExcelJS.Worksheet,
    startRow: number,
    fromRow: number,
    column: string,
  ): number | null {
    for (let row = fromRow; row >= startRow; row--) {
      const v = sheet.getRow(row).getCell(column).value;
      if (typeof v === 'number') return v;
      if (v && typeof v === 'object' && 'result' in v) {
        const n = Number((v as { result: unknown }).result);
        if (!isNaN(n)) return n;
      }
    }
    return null;
  }

  /**
   * Read transactions from workbook with optional filters
   */
  async readTransactions(
    workbook: ExcelJS.Workbook,
    filters?: TransactionFilters,
  ): Promise<TransactionRow[]> {
    const transactions: TransactionRow[] = [];

    // Resolve requested sheet names against the REAL workbook sheets.
    // The LLM sometimes emits decorated names ("SEPTEMBER (PhonePay/Wallet)")
    // copied from prompt prose — match case-insensitively after stripping
    // parentheticals; drop unresolvable names with a warning instead of
    // silently reading zero rows. If NOTHING resolves, fall back to defaults.
    const sheetsToRead = this.resolveSheetNames(
      workbook,
      filters?.sheets,
    );

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

    // "Latest" support: newest-first, capped. Only when a limit was requested.
    if (filters?.limit && filters.limit > 0) {
      transactions.sort((a, b) => b.date.getTime() - a.date.getTime());
      const capped = transactions.slice(0, filters.limit);
      this.logger.log(
        `Read ${capped.length} transactions (limited to newest ${filters.limit})`,
      );
      return capped;
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

    // Modes are stored inconsistently in real books ("Phone Pay" vs
    // "PHONEPAY" vs blank), so compare normalized on both sides instead of
    // strict equality — otherwise a modes:[PHONEPAY] filter silently drops
    // half the matching rows.
    if (filters.modes && filters.modes.length > 0) {
      const wanted = new Set(filters.modes.map((m) => normalizeModeLabel(m)));
      if (!wanted.has(normalizeModeLabel(tx.mode))) {
        return false;
      }
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
