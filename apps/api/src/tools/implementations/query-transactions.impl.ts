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

      // Scope completion (deterministic, owner-standing rule): the LLM
      // interpreter sometimes names a month sheet but omits dates, or gives
      // dates but no sheets ("september" asked in november must search the
      // SEPTEMBER sheet — never the current month's). Completed here so every
      // caller (single, combo sub, broaden) behaves identically.
      const completed = this.completeScope(input.filters);

      // Year fan-out: date-bounded queries read only the years in range;
      // unbounded queries read every yearly book (Budget_2026, Budget_2027,
      // …). An explicit s3KeyOverride (tests) pins to that key exactly —
      // legacy behavior preserved.
      const scopedInput = { ...input, filters: completed };
      const keys = await this.resolveReadKeys(scopedInput, s3KeyOverride);

      const transactions: TransactionRow[] = [];
      // Balances come from the book holding the latest transaction overall
      // (a newer year's book supersedes older closings) — UNLESS the user
      // explicitly named a single month ("september closing balance" asked in
      // november): then that month's own closings answer, not november's.
      let balances: QueryTransactionsOutput['balances'] = null;
      let latestBookTime = -Infinity;
      const scopedMonth = this.singleNamedMonth(
        scopedInput.filters,
        !!input.monthExplicit,
      );

      for (const key of keys) {
        // Step 1+2: Download + load this year's book.
        const workbookBuffer = await this.s3Service.downloadWorkbook(key);
        const workbook = await this.excelService.loadWorkbook(workbookBuffer);

        // Step 3: Read transactions with filters.
        const rows = await this.excelService.readTransactions(
          workbook,
          completed,
        );
        transactions.push(...rows);

        // Step 3b: authoritative balances when requested — keep the set
        // from the book with the latest row date seen so far.
        if (input.includeBalances) {
          let bookTime = -Infinity;
          for (const t of rows) {
            const d = t.date instanceof Date ? t.date.getTime() : NaN;
            if (!isNaN(d) && d > bookTime) {
              bookTime = d;
            }
          }
          if (bookTime >= latestBookTime) {
            latestBookTime = bookTime;
            balances = scopedMonth
              ? await this.excelService.getMonthClosingBalances(
                  workbook,
                  scopedMonth.sheet,
                  scopedMonth.asOf,
                )
              : await this.excelService.getCurrentBalances(workbook);
          }
        }
      }

      // Step 4: Perform aggregation if requested (over merged rows).
      let aggregation: QueryTransactionsOutput['aggregation'];
      if (input.aggregation) {
        aggregation = this.calculateAggregation(
          transactions,
          input.aggregation,
        );
      }

      this.logger.log(
        `Query completed: ${transactions.length} transactions across ${keys.length} book(s), aggregation=${aggregation ? 'yes' : 'no'}, balances=${balances ? 'yes' : 'no'}`,
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
   * Deterministic scope completion (owner-standing rule: the answer must
   * compute over the scope the user NAMED).
   * - Explicit month sheet(s) without dates → that month's dates (current
   *   year; the book is yearly and fan-out follows these bounds).
   * - Explicit month sheet(s) → CASH TRACKER rides along (Money/Bank rows of
   *   that month live there; without it "october total" misses october bank
   *   rows). Date bounds filter both sheets, so nothing extra leaks in.
   * - Dates without sheets ("september" asked in november, trailing windows
   *   spanning months) → the intersecting month sheets + CASH TRACKER, never
   *   a hardcoded current-month default.
   * - No dates and no sheets → untouched here (the interpreter applies the
   *   current-month default; consent-broadened turns must stay all-time).
   */
  private completeScope(
    filters: QueryTransactionsInput['filters'],
  ): QueryTransactionsInput['filters'] {
    const f = { ...(filters || {}) } as NonNullable<
      QueryTransactionsInput['filters']
    >;
    const sheets = (f.sheets || []).map((s) => String(s));
    const monthSheets = sheets.filter((s) =>
      MONTH_NAMES.includes(s.toUpperCase()),
    );
    const hasDates = !!(f.dateFrom || f.dateTo);

    if (monthSheets.length > 0) {
      if (!sheets.some((s) => s.toUpperCase() === 'CASH TRACKER')) {
        sheets.push('CASH TRACKER');
      }
      f.sheets = sheets;
      if (!hasDates) {
        const { dateFrom, dateTo } = monthDateRange(
          monthSheets[0].toUpperCase(),
          new Date().getFullYear(),
        );
        f.dateFrom = dateFrom;
        f.dateTo = dateTo;
      }
      return f;
    }

    if (hasDates && sheets.length === 0) {
      f.sheets = [...monthsIntersecting(f.dateFrom, f.dateTo), 'CASH TRACKER'];
    }
    return f;
  }

  /**
   * Single explicitly-named month for balance reads: when the workflow marks
   * the turn monthExplicit and the completed filters name exactly one month
   * sheet, balances answer from that month's own closings (as of its
   * month-end), not from the current month. Otherwise null (global current
   * balances).
   */
  private singleNamedMonth(
    filters: QueryTransactionsInput['filters'],
    monthExplicit: boolean,
  ): { sheet: string; asOf: Date } | null {
    if (!monthExplicit) {
      return null;
    }
    const sheets = (filters?.sheets || []).map((s) => String(s));
    const monthSheets = sheets.filter((s) =>
      MONTH_NAMES.includes(s.toUpperCase()),
    );
    if (monthSheets.length !== 1) {
      return null;
    }
    const { dateTo } = monthDateRange(
      monthSheets[0].toUpperCase(),
      yearOf(filters?.dateTo) ?? new Date().getFullYear(),
    );
    return { sheet: monthSheets[0].toUpperCase(), asOf: new Date(dateTo) };
  }

  /**
   * Resolve which workbook keys a query reads. Date bounds map to their
   * years (intersected with keys that actually exist); unbounded queries
   * read every yearly book so all-time questions stay complete.
   */
  private async resolveReadKeys(
    input: QueryTransactionsInput,
    s3KeyOverride?: string,
  ): Promise<string[]> {
    if (s3KeyOverride) {
      return [s3KeyOverride];
    }
    const years = this.yearsFromFilters(input.filters);
    if (!years) {
      return this.s3Service.listWorkbookKeys();
    }
    const existing = await this.s3Service.listWorkbookKeys();
    const wanted = years.map((y) => this.s3Service.workbookKeyFor(y));
    const found = wanted.filter((k) => existing.includes(k));
    if (found.length > 0) {
      return found;
    }
    // No year-keyed book matched. Fall back to the configured default key
    // ONLY when it is yearless (custom/test keys carry no year) or its own
    // year is in range — otherwise an honest empty (a missing future book
    // must never silently serve another year's rows).
    const defaultYear = this.s3Service.yearOfKey(
      this.s3Service.defaultKey,
    );
    if (defaultYear === null || years.includes(defaultYear)) {
      return [this.s3Service.defaultKey];
    }
    this.logger.warn(
      `No workbook keys found for years [${years.join(', ')}] — reading nothing`,
    );
    return [];
  }

  /**
   * Calendar years spanned by the query's date bounds, or null when
   * unbounded (meaning: read every book).
   */
  private yearsFromFilters(filters?: {
    dateFrom?: string;
    dateTo?: string;
  }): number[] | null {
    const from = filters?.dateFrom ? new Date(filters.dateFrom) : null;
    const to = filters?.dateTo ? new Date(filters.dateTo) : null;
    const valid = (d: Date | null): d is Date =>
      d instanceof Date && !isNaN(d.getTime());
    if (!valid(from) && !valid(to)) {
      return null;
    }
    const startYear = valid(from)
      ? from.getFullYear()
      : valid(to)
        ? to.getFullYear()
        : new Date().getFullYear();
    const endYear = valid(to) ? to.getFullYear() : startYear;
    const years: number[] = [];
    for (let y = Math.min(startYear, endYear); y <= Math.max(startYear, endYear); y++) {
      years.push(y);
    }
    return years;
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

/** Month-sheet names (UPPER) — the book's month-sheet convention. */
const MONTH_NAMES = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
];

/** First/last calendar day (YYYY-MM-DD) of a month in a year. */
function monthDateRange(
  monthName: string,
  year: number,
): { dateFrom: string; dateTo: string } {
  const idx = MONTH_NAMES.indexOf(monthName.toUpperCase());
  const m = idx >= 0 ? idx : new Date().getMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(year, m + 1, 0).getDate();
  return {
    dateFrom: `${year}-${pad(m + 1)}-01`,
    dateTo: `${year}-${pad(m + 1)}-${pad(lastDay)}`,
  };
}

/** Year of an ISO date bound, or null when absent/invalid. */
function yearOf(bound?: string): number | null {
  if (!bound) {
    return null;
  }
  const d = new Date(bound);
  return isNaN(d.getTime()) ? null : d.getFullYear();
}

/**
 * Month sheets intersecting [dateFrom, dateTo] (inclusive, UPPER names).
 * Open-ended side extends to that side's current month; garbage in →
 * empty out (callers fall back to defaults).
 */
function monthsIntersecting(dateFrom?: string, dateTo?: string): string[] {
  const now = new Date();
  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;
  const valid = (d: Date | null): d is Date =>
    d instanceof Date && !isNaN(d.getTime());
  const start = valid(from) ? from : valid(to) ? to : now;
  const end = valid(to) ? to : valid(from) ? from : now;
  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;
  const out: string[] = [];
  const cursor = new Date(lo.getFullYear(), lo.getMonth(), 1);
  const last = new Date(hi.getFullYear(), hi.getMonth(), 1);
  let guard = 0;
  while (cursor <= last && guard++ < 36) {
    out.push(MONTH_NAMES[cursor.getMonth()]);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return out;
}
