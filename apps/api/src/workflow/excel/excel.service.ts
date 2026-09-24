import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import JSZip from 'jszip';
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
  WORKBOOK_COLORS,
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
   * Export workbook to buffer.
   *
   * ExcelJS unconditionally serializes an <autoFilter> node (ref-less,
   * invented — the owner's tables were built WITHOUT autofilter) into every
   * table part on write. Desktop Excel flags exactly that as unreadable
   * content ("Removed Records: AutoFilter from /xl/tables/table1.xml") on
   * EVERY open, so strip invented ref-less autoFilters post-export. Tables
   * themselves (values, style) are untouched.
   */
  async exportWorkbook(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const result = await workbook.xlsx.writeBuffer();
    return this.stripInventedTableAutoFilters(
      Buffer.from(result as ArrayBuffer),
    );
  }

  /**
   * Remove ref-less <autoFilter> nodes ExcelJS invents inside table parts.
   * Only ref-less nodes are stripped (a real filtered table keeps its UI);
   * everything else in the package passes through byte-identical.
   */
  private async stripInventedTableAutoFilters(raw: Buffer): Promise<Buffer> {
    const zip = await JSZip.loadAsync(raw);
    const parts = Object.keys(zip.files).filter((n) =>
      /^xl\/tables\/table\d+\.xml$/.test(n),
    );
    if (parts.length === 0) {
      return raw;
    }
    let touched = false;
    for (const part of parts) {
      const xml = await zip.files[part].async('string');
      if (!xml.includes('<autoFilter')) {
        continue;
      }
      const cleaned = xml
        .replace(
          /<autoFilter(?![^>]*\bref=)[^>]*>[\s\S]*?<\/autoFilter\s*>/g,
          '',
        )
        .replace(/<autoFilter(?![^>]*\bref=)[^>]*\/>/g, '');
      if (cleaned !== xml) {
        zip.file(part, cleaned);
        touched = true;
        this.logger.log(`Stripped invented table autoFilter from ${part}`);
      }
    }
    if (!touched) {
      return raw;
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
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
   * Month name (UPPER) for a date — the month-sheet convention.
   * No month is ever hardcoded: October writes land in OCTOBER, whether it
   * exists yet or not (see ensureMonthSheet).
   */
  monthNameFor(date: Date): string {
    const months = [
      'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
      'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
    ];
    return months[date.getMonth()];
  }

  /**
   * Determine destination sheet and balance column for a payment mode.
   * PhonePe/Wallet rows live in the MONTH sheet of the transaction date
   * (routing by date — never a hardcoded month); Money/Bank live in the
   * single continuous CASH TRACKER.
   */
  determineSheetAndColumn(
    mode: PaymentMode,
    txDate: Date = new Date(),
  ): SheetRouting {
    const normalizedMode = mode.toUpperCase().replace(/\s+/g, '');

    if (normalizedMode === 'PHONEPAY') {
      return { sheetName: this.monthNameFor(txDate), balanceColumn: 'H' };
    } else if (normalizedMode === 'WALLET') {
      return { sheetName: this.monthNameFor(txDate), balanceColumn: 'I' };
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
      // Any month sheet (header row 4, date in C)
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

    // Fresh month sheet (no dated rows yet): fall back to the opening
    // balances in the summary cards (L7 = WALLET, L8 = PHNPE), carried from
    // the previous month's closing by ensureMonthSheet. Without this, the
    // first write of a new month would compute from 0.
    if (lastRow === headerRow && sheetName !== 'CASH TRACKER') {
      const openingCell =
        balanceColumn === 'H'
          ? sheet.getRow(8).getCell('L').value
          : sheet.getRow(7).getCell('L').value;
      if (typeof openingCell === 'number') {
        currentBalance = openingCell;
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
      // Parse date FIRST — month-sheet routing depends on it (never a
      // hardcoded month; October writes land in OCTOBER).
      const txDate = typeof tx.date === 'string' ? new Date(tx.date) : tx.date;

      // Determine routing
      const routing = this.determineSheetAndColumn(tx.mode, txDate);
      let sheet = workbook.getWorksheet(routing.sheetName);

      // Month rollover: create the month sheet from template on first write
      // (openings carried from the previous month's closing). CASH TRACKER
      // is continuous and must already exist.
      if (!sheet && routing.sheetName !== 'CASH TRACKER') {
        sheet = this.ensureMonthSheet(workbook, routing.sheetName, txDate);
      }

      if (!sheet) {
        throw new Error(`Sheet "${routing.sheetName}" not found`);
      }

      // Cosmetic normalization (idempotent): heals sheets built before the
      // merge-master/legend/view rules existed. Gap-fills only, never
      // overwrites user data.
      if (routing.sheetName !== 'CASH TRACKER') {
        this.normalizeMonthSheetCosmetics(workbook, routing.sheetName);
      }

      // Find last row and BOTH running balances. Book convention carries
      // both balances on every row (H=PhonePay/Money, I=Wallet/Bank), so a
      // fresh month's first row can inherit its wallet opening and no cell
      // is left blank that the book would fill.
      const first = this.findLastRowAndBalance(
        sheet,
        routing.sheetName,
        'H',
      );
      const second = this.findLastRowAndBalance(
        sheet,
        routing.sheetName,
        'I',
      );
      const lastRow = first.lastRow;

      const balanceH =
        routing.balanceColumn === 'H'
          ? this.calculateNewBalance(
              first.currentBalance,
              tx.amount,
              tx.direction,
            )
          : first.currentBalance;
      const balanceI =
        routing.balanceColumn === 'I'
          ? this.calculateNewBalance(
              second.currentBalance,
              tx.amount,
              tx.direction,
            )
          : second.currentBalance;

      const newRow = lastRow + 1;

      // Canonical new balance for cards/summary (the mode's own column).
      const newBalance =
        routing.balanceColumn === 'H' ? balanceH : balanceI;

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
        row.getCell('H').value = balanceH;
        row.getCell('I').value = balanceI;
      } else {
        // Month sheet format: C=Date, D=Description, E=Mode, F=Debit, G=Credit, H=PhnPe, I=Wallet
        row.getCell('C').value = txDate;
        row.getCell('D').value = sheetDescription;
        row.getCell('E').value = tx.mode;
        row.getCell('F').value = tx.direction === 'DEBIT' ? tx.amount : null;
        row.getCell('G').value = tx.direction === 'CREDIT' ? tx.amount : null;
        row.getCell('H').value = balanceH;
        row.getCell('I').value = balanceI;
      }

      // Apply color rules (CASH TRACKER rows start at B/Month — color it too)
      this.rulesService.applyRowColor(
        row,
        tx.direction,
        tx.colourCategory,
        routing.sheetName === 'CASH TRACKER' ? 2 : 3,
      );

      // Month boundaries (owner's convention): the FIRST dated row's balances
      // carry the legend's OPENING fill — a month's start is known the moment
      // it arrives. CLOSING is NEVER painted here: it marks a month's FINAL
      // row and is applied only at month handoff (sealPreviousMonths, when
      // the next month's first transaction lands). Painting every latest row
      // made "closing" mean "latest" — every conversation turned navy.
      if (routing.sheetName !== 'CASH TRACKER' && lastRow <= 4) {
        const opening = this.openingFill(workbook);
        for (const col of ['H', 'I']) {
          const cell = sheet.getRow(newRow).getCell(col);
          cell.style = {
            ...cell.style,
            fill: JSON.parse(JSON.stringify(opening)),
          };
        }
      }

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
        // Seal other months' latest rows closed (asked explicitly; H/I only,
        // values untouched).
        this.sealPreviousMonths(workbook, routing.sheetName);
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
   * Month-sheet structure: Row 7 = WALLET (Col L), Row 8 = PHNPE (Col L).
   * Identical on every rolled month sheet (cloned by ensureMonthSheet).
   */
  private async updateMonthlySummary(
    sheet: ExcelJS.Worksheet,
    mode: PaymentMode,
    balanceColumn: string,
    newBalance: number,
  ): Promise<void> {
    const normalizedMode = mode.toUpperCase().replace(/\s+/g, '');

    let summaryRow: number;
    if (normalizedMode === 'PHONEPAY' || balanceColumn === 'H') {
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
   * Copy one cell's value + style between worksheets (same or different
   * workbooks). Shared style refs are never mutated afterwards — only cell
   * values change post-clone, never styles.
   */
  private copyCellTo(
    srcSheet: ExcelJS.Worksheet,
    dstSheet: ExcelJS.Worksheet,
    addr: string,
    valueOverride?: ExcelJS.CellValue,
  ): void {
    const m = addr.match(/^([A-Z]+)(\d+)$/) || ['', 'A', '1'];
    const src = srcSheet.getRow(Number(m[2])).getCell(m[1]);
    const dst = dstSheet.getRow(Number(m[2])).getCell(m[1]);
    dst.value =
      valueOverride !== undefined ? valueOverride : src.value;
    if (src.style) {
      dst.style = { ...src.style };
    }
  }

  /**
   * Month rollover: create a month sheet from the SEPTEMBER template when
   * the first transaction of a new month arrives. Clones structure only —
   * title/header geometry, merges, widths, summary cards, legend — never
   * transaction rows. Openings (K7/L7 WALLET, K8/L8 PHNPE) are carried from
   * the previous latest month's closing balances (0 when no history).
   *
   * Geometry cloned from the live book: title merge C2:J2, header row 4
   * (h23), K4:P4 + K5:P5 merged titles, K11:M11 legend merge, K/L summary
   * cards, full column widths. Transaction zone (rows 5-10, C..I) stays
   * empty — the new month starts clean.
   */
  ensureMonthSheet(
    workbook: ExcelJS.Workbook,
    monthName: string,
    txDate: Date,
    openings?: { phonepay: number; wallet: number } | null,
  ): ExcelJS.Worksheet {
    const existing = workbook.getWorksheet(monthName);
    if (existing) {
      return existing;
    }

    const template =
      workbook.getWorksheet('SEPTEMBER') ||
      workbook.worksheets.find(
        (s) => s.name !== 'TERMINOLOGY' && s.name !== 'CASH TRACKER',
      );
    if (!template) {
      throw new Error(
        `Cannot create month sheet "${monthName}": no template month sheet found`,
      );
    }

    // Previous closing per mode (scan all month sheets by latest date),
    // unless the caller carries closings across (year rollover).
    let phonepayOpen = openings?.phonepay ?? 0;
    let walletOpen = openings?.wallet ?? 0;
    if (!openings) {
      let latestTime = -Infinity;
      for (const sheet of workbook.worksheets) {
        if (sheet.name === 'TERMINOLOGY' || sheet.name === 'CASH TRACKER') {
          continue;
        }
        const last = this.findLastDatedRow(sheet, 4, 'C');
        if (!last || last.date.getTime() <= latestTime) {
          continue;
        }
        latestTime = last.date.getTime();
        const h = this.lastNumericInColumn(sheet, 5, last.row, 'H');
        const i = this.lastNumericInColumn(sheet, 5, last.row, 'I');
        phonepayOpen = h === null ? phonepayOpen : h;
        walletOpen = i === null ? walletOpen : i;
      }
    }

    return this.buildMonthSheet(
      workbook,
      template,
      monthName,
      txDate,
      phonepayOpen,
      walletOpen,
    );
  }

  /**
   * Build a month sheet onto a workbook from an explicit template sheet.
   * Used by ensureMonthSheet (same-book template) and createYearWorkbook
   * (cross-book template — a new year book has no month sheet of its own).
   */
  private buildMonthSheet(
    workbook: ExcelJS.Workbook,
    template: ExcelJS.Worksheet,
    monthName: string,
    txDate: Date,
    phonepayOpen: number,
    walletOpen: number,
  ): ExcelJS.Worksheet {
    const year = txDate.getFullYear();
    const titleCase =
      monthName.charAt(0) + monthName.slice(1).toLowerCase();
    const sheet = workbook.addWorksheet(monthName);

    // Column widths (template fidelity).
    template.columns.forEach((col) => {
      if (col.width && col.number) {
        sheet.getColumn(col.number).width = col.width;
      }
    });

    // Row heights for the structure zone.
    for (let r = 1; r <= 12; r++) {
      const h = template.getRow(r).height;
      if (h) {
        sheet.getRow(r).height = h;
      }
    }

    // Title row 2 (merged C2:J2) + header row 4 (C..I) + K4 title.
    for (const col of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
      this.copyCellTo(template, sheet, `${col}2`, `${monthName} ${year} — EXPENSE TRACKER`);
    }
    for (const col of ['C', 'D', 'E', 'F', 'G', 'H', 'I']) {
      this.copyCellTo(template, sheet, `${col}4`);
    }
    this.copyCellTo(template, sheet, 'K4');
    for (const col of ['K', 'L', 'M', 'N', 'O', 'P']) {
      this.copyCellTo(template, sheet, `${col}4`);
      this.copyCellTo(template, sheet, `${col}5`, `${titleCase} ${year} at a glance`);
    }
    sheet.mergeCells('C2:J2');
    sheet.mergeCells('K4:P4');
    sheet.mergeCells('K5:P5');

    // Merge-master discipline: only the top-left cell of a merged range may
    // carry a value (Excel-strict readers flag multi-valued merges).
    this.clearMergeSlaves(sheet, [
      'C2:J2',
      'K4:P4',
      'K5:P5',
      'K11:M11',
    ]);

    // Summary cards with carried openings.
    this.copyCellTo(template, sheet, 'K7');
    this.copyCellTo(template, sheet, 'L7', walletOpen);
    this.copyCellTo(template, sheet, 'K8');
    this.copyCellTo(template, sheet, 'L8', phonepayOpen);

    // Legend block (static book text + color swatches, preserved verbatim —
    // swatches are fills on EMPTY cells, so copy by fill-presence too).
    this.copyCellTo(template, sheet, 'K11');
    this.copyCellTo(template, sheet, 'L11');
    this.copyCellTo(template, sheet, 'M11');
    const l12 = template.getRow(12).getCell('L').value;
    if (l12 !== null && l12 !== undefined && l12 !== '') {
      this.copyCellTo(template, sheet, 'L12');
    }
    for (let r = 13; r <= 21; r++) {
      const h = template.getRow(r).height;
      if (h) {
        sheet.getRow(r).height = h;
      }
      for (const col of ['K', 'L', 'M']) {
        const src = template.getRow(r).getCell(col);
        const hasValue =
          src.value !== null && src.value !== undefined && src.value !== '';
        const hasFill = !!src.style?.fill;
        if (hasValue || hasFill) {
          this.copyCellTo(
            template,
            sheet,
            `${col}${r}`,
          );
        }
      }
    }
    sheet.mergeCells('K11:M11');

    // View fidelity (zoom/spacing perception). Never assign null —
    // a null views array emits sheet XML Excel flags as corrupt.
    try {
      const views = JSON.parse(JSON.stringify(template.views || []));
      if (Array.isArray(views) && views.length > 0) {
        sheet.views = views;
      }
    } catch {
      // Cosmetic only — a missing view never breaks data.
    }
    if (!Array.isArray((sheet as unknown as { views: unknown }).views)) {
      try {
        (sheet as unknown as { views: unknown }).views = [
          { state: 'frozen', xSplit: 0, ySplit: 0 },
        ];
      } catch {
        // Cosmetic only.
      }
    }

    this.logger.log(
      `Created month sheet "${monthName}" from template (openings PHONEPAY=${phonepayOpen}, WALLET=${walletOpen})`,
    );
    return sheet;
  }

  /**
   * Year rollover: build a new yearly workbook from a template (previous
   * year's) book. Carries forward exactly what the owner specified:
   * - TERMINOLOGY copied VERBATIM (every rule, list and card — the agent's
   *   rulebook must survive the year boundary untouched);
   * - CASH TRACKER structure cloned WITHOUT transaction rows, top cards
   *   (D5 BANK, D6 MONEY) and TERMINOLOGY CURR cards set to carried balances;
   * - JANUARY month sheet created with phonepay/wallet openings carried.
   * Transaction rows never cross the boundary — each year's book holds only
   * its own year's rows. CASH balances chain via the carried top cards.
   */
  createYearWorkbook(
    templateWb: ExcelJS.Workbook,
    year: number,
    openings: { money: number; bank: number; phonepay: number; wallet: number },
  ): ExcelJS.Workbook {
    const wb = new ExcelJS.Workbook();

    // 1. TERMINOLOGY verbatim (values, styles, merges, widths, heights).
    const termSrc = templateWb.getWorksheet('TERMINOLOGY');
    if (!termSrc) {
      throw new Error('Template workbook has no TERMINOLOGY sheet');
    }
    const term = wb.addWorksheet('TERMINOLOGY');
    termSrc.columns.forEach((col) => {
      if (col.width && col.number) {
        term.getColumn(col.number).width = col.width;
      }
    });
    for (let r = 1; r <= termSrc.rowCount; r++) {
      const h = termSrc.getRow(r).height;
      if (h) {
        term.getRow(r).height = h;
      }
      for (let c = 1; c <= termSrc.columnCount; c++) {
        const addr = `${termSrc.getColumn(c).letter}${r}`;
        this.copyCellTo(termSrc, term, addr);
      }
    }
    for (const range of termSrc.model.merges || []) {
      term.mergeCells(range);
    }

    // 2. CASH TRACKER structure (rows 1-10: titles, top cards, legend,
    // header), no transaction rows. Title year swapped; top cards carried.
    const cashSrc = templateWb.getWorksheet('CASH TRACKER');
    if (!cashSrc) {
      throw new Error('Template workbook has no CASH TRACKER sheet');
    }
    const cash = wb.addWorksheet('CASH TRACKER');
    cashSrc.columns.forEach((col) => {
      if (col.width && col.number) {
        cash.getColumn(col.number).width = col.width;
      }
    });
    for (let r = 1; r <= 10; r++) {
      const h = cashSrc.getRow(r).height;
      if (h) {
        cash.getRow(r).height = h;
      }
      const maxCol = Math.max(cashSrc.columnCount, 22);
      for (let c = 1; c <= maxCol; c++) {
        const addr = `${cashSrc.getColumn(c).letter}${r}`;
        let value: ExcelJS.CellValue | undefined;
        const raw = cashSrc.getRow(r).getCell(c).value;
        if (typeof raw === 'string') {
          value = raw.replace(/\b20\d{2}\b/g, String(year)) as ExcelJS.CellValue;
        } else {
          value = undefined;
        }
        if (value !== undefined) {
          this.copyCellTo(cashSrc, cash, addr, value);
        } else {
          this.copyCellTo(cashSrc, cash, addr);
        }
      }
    }
    for (const range of cashSrc.model.merges || []) {
      cash.mergeCells(range);
    }
    // Carried top cards + terminology CURR mirror.
    this.updateLabeledCard(cash, 'BANK', openings.bank);
    this.updateLabeledCard(cash, 'MONEY', openings.money);
    this.updateLabeledCard(term, 'BANK[CURR]', openings.bank);
    this.updateLabeledCard(term, 'MONEY[CURR]', openings.money);

    // 3. JANUARY with carried phonepay/wallet openings (template comes from
    // the OLD book — the new one has no month sheet of its own yet).
    const monthTemplate =
      templateWb.getWorksheet('SEPTEMBER') ||
      templateWb.worksheets.find(
        (s) => s.name !== 'TERMINOLOGY' && s.name !== 'CASH TRACKER',
      );
    if (!monthTemplate) {
      throw new Error('Template workbook has no month sheet to clone');
    }
    this.buildMonthSheet(
      wb,
      monthTemplate,
      'JANUARY',
      new Date(year, 0, 15),
      openings.phonepay,
      openings.wallet,
    );

    this.logger.log(
      `Created year workbook for ${year} (carried MONEY=${openings.money}, BANK=${openings.bank}, PHONEPAY=${openings.phonepay}, WALLET=${openings.wallet})`,
    );
    return wb;
  }

  /**
   * Clear values of non-master cells inside merged ranges (styles kept).
   * Excel-strict readers flag multi-valued merges; everything WE emit is
   * master-only. Must unmerge first: ExcelJS links slave reads/writes to
   * the master while merged, so clearing slaves in place wipes the master.
   */
  private clearMergeSlaves(sheet: ExcelJS.Worksheet, ranges: string[]): void {
    const colToNum = (col: string): number => {
      let n = 0;
      for (const ch of col) {
        n = n * 26 + (ch.charCodeAt(0) - 64);
      }
      return n;
    };
    const numToCol = (n: number): string => {
      let s = '';
      while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
    };
    for (const range of ranges) {
      const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (!m) {
        continue;
      }
      const [, c1, r1, c2, r2] = m;
      const masterRow = Number(r1);
      const masterCol = colToNum(c1);
      const masterAddr = `${c1}${r1}`;
      const masterValue = sheet.getRow(masterRow).getCell(masterAddr).value;
      const masterStyle = sheet.getRow(masterRow).getCell(masterAddr).style
        ? { ...sheet.getRow(masterRow).getCell(masterAddr).style }
        : undefined;
      try {
        sheet.unMergeCells(range);
      } catch {
        continue;
      }
      for (let r = Number(r1); r <= Number(r2); r++) {
        for (let c = colToNum(c1); c <= colToNum(c2); c++) {
          if (r === masterRow && c === masterCol) {
            continue;
          }
          const cell = sheet.getRow(r).getCell(numToCol(c));
          if (
            cell.value !== null &&
            cell.value !== undefined &&
            cell.value !== ''
          ) {
            cell.value = undefined;
          }
        }
      }
      const master = sheet.getRow(masterRow).getCell(masterAddr);
      master.value = masterValue as ExcelJS.CellValue;
      if (masterStyle) {
        master.style = masterStyle;
      }
      try {
        sheet.mergeCells(range);
      } catch {
        // Cosmetic only — data already correct unmerged.
      }
    }
  }

  /**
   * Idempotent cosmetic normalization for month sheets (repairs sheets built
   * before these rules existed, like the first OCTOBER): merge-master
   * values cleared, legend swatches filled from SEPTEMBER, view zoom
   * matched, first-row empty balances filled from summary cards. Never
   * overwrites user data — only fills gaps.
   */
  normalizeMonthSheetCosmetics(
    workbook: ExcelJS.Workbook,
    monthName: string,
  ): void {
    const sheet = workbook.getWorksheet(monthName);
    if (!sheet || monthName === 'TERMINOLOGY' || monthName === 'CASH TRACKER') {
      return;
    }
    const template =
      workbook.getWorksheet('SEPTEMBER') ||
      workbook.worksheets.find(
        (s) => s.name !== 'TERMINOLOGY' && s.name !== 'CASH TRACKER',
      );
    if (!template || template === sheet) {
      return;
    }

    this.clearMergeSlaves(sheet, ['C2:J2', 'K4:P4', 'K5:P5', 'K11:M11']);

    // Legend rows 11-21, cols K..M: fill gaps from template (values + fills).
    // A swatch is a fill on an EMPTY cell, so any fill counts — not just
    // fgColor fills (theme/indexed fills carry no fgColor yet still paint).
    for (let r = 11; r <= 21; r++) {
      for (const col of ['K', 'L', 'M']) {
        const src = template.getRow(r).getCell(col);
        const dst = sheet.getRow(r).getCell(col);
        const srcHas =
          (src.value !== null && src.value !== undefined && src.value !== '') ||
          !!src.style?.fill;
        const dstHas =
          dst.value !== null && dst.value !== undefined && dst.value !== '';
        if (srcHas && !dstHas) {
          dst.value = src.value as ExcelJS.CellValue;
          if (src.style) {
            dst.style = { ...src.style };
          }
        }
      }
    }

    // View zoom fidelity. Never leave views null — null views emit
    // sheet XML Excel flags as corrupt (recovery prompt + blank grid).
    try {
      const views = JSON.parse(JSON.stringify(template.views || []));
      if (Array.isArray(views) && views.length > 0) {
        sheet.views = views;
      } else if (!Array.isArray((sheet as unknown as { views: unknown }).views)) {
        (sheet as unknown as { views: unknown }).views = [
          { state: 'frozen', xSplit: 0, ySplit: 0 },
        ];
      }
    } catch {
      // Cosmetic only.
    }

    // First data row: empty H/I balances inherit the summary-card openings.
    let firstDated = -1;
    for (let r = 5; r <= sheet.rowCount; r++) {
      if (sheet.getRow(r).getCell('C').value) {
        firstDated = r;
        break;
      }
    }
    if (firstDated > 0) {
      const hCell = sheet.getRow(firstDated).getCell('H');
      const iCell = sheet.getRow(firstDated).getCell('I');
      if (
        (hCell.value === null || hCell.value === undefined || hCell.value === '') &&
        typeof sheet.getRow(8).getCell('L').value === 'number'
      ) {
        hCell.value = sheet.getRow(8).getCell('L').value as number;
      }
      if (
        (iCell.value === null || iCell.value === undefined || iCell.value === '') &&
        typeof sheet.getRow(7).getCell('L').value === 'number'
      ) {
        iCell.value = sheet.getRow(7).getCell('L').value as number;
      }
    }
  }

  /**
   * Legend swatch fill for OPENING/CLOSING balance (the K-column swatch on
   * the same legend row as the L-column label, rows 11-21 of a month sheet).
   * The owner's legend uses THEME fills (no ARGB) — copying the swatch object
   * verbatim reproduces the exact cell color; hardcoded ARGBs only serve as
   * fallback when no legend exists (fresh books built without one).
   */
  private legendFill(
    workbook: ExcelJS.Workbook,
    label: 'OPENING BALANCE' | 'CLOSING BALANCE',
  ): ExcelJS.Fill | null {
    const template =
      workbook.getWorksheet('SEPTEMBER') ||
      workbook.worksheets.find(
        (s) => s.name !== 'TERMINOLOGY' && s.name !== 'CASH TRACKER',
      );
    if (!template) {
      return null;
    }
    for (let r = 11; r <= 21; r++) {
      for (const col of ['K', 'L', 'M']) {
        const v = template.getRow(r).getCell(col).value;
        if (
          typeof v === 'string' &&
          v.toUpperCase().replace(/\s+/g, '') ===
            label.replace(/\s+/g, '')
        ) {
          const fill = template.getRow(r).getCell('K').style?.fill;
          if (fill && (fill as { fgColor?: unknown }).fgColor) {
            return JSON.parse(JSON.stringify(fill)) as ExcelJS.Fill;
          }
        }
      }
    }
    return null;
  }

  private openingFill(workbook: ExcelJS.Workbook): ExcelJS.Fill {
    return (
      this.legendFill(workbook, 'OPENING BALANCE') ?? {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: WORKBOOK_COLORS.OPENING_BALANCE },
      }
    );
  }

  private closingFill(workbook: ExcelJS.Workbook): ExcelJS.Fill {
    return (
      this.legendFill(workbook, 'CLOSING BALANCE') ?? {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: WORKBOOK_COLORS.CLOSING_BALANCE },
      }
    );
  }

  /**
   * Seal every OTHER month sheet's latest dated row with the legend's CLOSING
   * fill (H/I only). This is the ONLY place CLOSING is ever painted: a month
   * is sealed at handoff, when the next month's first transaction lands.
   * First rows and middles are never touched — history is preserved, not
   * rewritten. CASH TRACKER is continuous and never sealed.
   */
  private sealPreviousMonths(
    workbook: ExcelJS.Workbook,
    currentMonthName: string,
  ): void {
    const closing = this.closingFill(workbook);
    for (const sheet of workbook.worksheets) {
      if (
        sheet.name === 'TERMINOLOGY' ||
        sheet.name === 'CASH TRACKER' ||
        sheet.name === currentMonthName
      ) {
        continue;
      }
      const last = this.findLastDatedRow(sheet, 4, 'C');
      if (!last) {
        continue;
      }
      for (const col of ['H', 'I']) {
        const cell = sheet.getRow(last.row).getCell(col);
        if (
          cell.value !== null &&
          cell.value !== undefined &&
          cell.value !== ''
        ) {
          cell.style = {
            ...cell.style,
            fill: JSON.parse(JSON.stringify(closing)),
          };
        }
      }
    }
  }

  private resolveSheetNames(
    workbook: ExcelJS.Workbook,
    requested?: string[],
  ): string[] {
    // Defaults follow the calendar, never a hardcoded month: the current
    // month sheet (created on first write) plus the continuous CASH TRACKER.
    const defaults = [this.monthNameFor(new Date()), 'CASH TRACKER'];

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
   * Read a single month's CLOSING balances as of a date (month-end for
   * "september closing balance" questions asked later): the month sheet's
   * last H/I values on/before asOf, plus CASH TRACKER's last H/I on/before
   * asOf (Money/Bank closings for that month — the continuous sheet has no
   * per-month cards). Absent rows stay null, never zero-invented.
   */
  async getMonthClosingBalances(
    workbook: ExcelJS.Workbook,
    monthSheetName: string,
    asOf: Date,
  ): Promise<SheetBalances> {
    let phonepay: number | null = null;
    let wallet: number | null = null;
    const sheet = workbook.getWorksheet(monthSheetName.toUpperCase());
    if (sheet) {
      let bestRow = -1;
      for (let row = 5; row <= sheet.rowCount; row++) {
        const v = sheet.getRow(row).getCell('C').value;
        if (!v) {
          continue;
        }
        const d = v instanceof Date ? v : new Date(String(v));
        if (isNaN(d.getTime()) || d > asOf) {
          continue;
        }
        bestRow = row;
      }
      if (bestRow > 0) {
        phonepay = this.lastNumericInColumn(sheet, 5, bestRow, 'H');
        wallet = this.lastNumericInColumn(sheet, 5, bestRow, 'I');
      }
    }

    let money: number | null = null;
    let bank: number | null = null;
    const cash = workbook.getWorksheet('CASH TRACKER');
    if (cash) {
      let bestRow = -1;
      for (let row = 11; row <= cash.rowCount; row++) {
        const v = cash.getRow(row).getCell('C').value;
        if (!v) {
          continue;
        }
        const d = v instanceof Date ? v : new Date(String(v));
        if (isNaN(d.getTime()) || d > asOf) {
          continue;
        }
        bestRow = row;
      }
      if (bestRow > 0) {
        money = this.lastNumericInColumn(cash, 11, bestRow, 'H');
        bank = this.lastNumericInColumn(cash, 11, bestRow, 'I');
      }
    }

    const balances = { PHONEPAY: phonepay, WALLET: wallet, MONEY: money, BANK: bank };
    this.logger.log(
      `Month-closing balances ${monthSheetName} as of ${asOf.toISOString().slice(0, 10)}: ${JSON.stringify(balances)}`,
    );
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
    // Explicit null sheets = consent-broadened ("yes, show all"): read EVERY
    // month sheet + CASH TRACKER, never the current-month default.
    const sheetsToRead =
      filters?.sheets === null
        ? [
            ...workbook.worksheets
              .map((s) => s.name)
              .filter(
                (n) => n !== 'TERMINOLOGY' && n !== 'CASH TRACKER',
              ),
            'CASH TRACKER',
          ].filter((s) => workbook.getWorksheet(s))
        : this.resolveSheetNames(workbook, filters?.sheets);

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

    // Fixed sheets plus at least one month sheet (any month — the book
    // rolls monthly, so no single month name is required).
    const requiredSheets = ['TERMINOLOGY', 'CASH TRACKER'];
    for (const sheetName of requiredSheets) {
      if (!workbook.getWorksheet(sheetName)) {
        errors.push(`Required sheet "${sheetName}" not found`);
      }
    }
    const hasMonthSheet = workbook.worksheets.some(
      (s) =>
        s.name !== 'TERMINOLOGY' && s.name !== 'CASH TRACKER',
    );
    if (!hasMonthSheet) {
      errors.push('No month sheet found');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
