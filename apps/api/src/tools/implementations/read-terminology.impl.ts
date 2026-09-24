/**
 * read_terminology Tool Implementation
 *
 * Deterministic read of the user's own TERMINOLOGY word lists (FOR_HOME,
 * PERSONAL, WISHLIST) from the workbook. Answers "what is my wishlist"
 * with the user's words — never with wishlist-colored transactions (those
 * are a different question, served by query_transactions + category filter).
 *
 * Read-only: downloads, never mutates, never uploads.
 */

import { Injectable, Logger } from '@nestjs/common';
import { S3Service } from '../../workflow/storage/s3.service';
import { ExcelService } from '../../workflow/excel/excel.service';
import { ReadTerminologyInput, ReadTerminologyOutput } from '../tool.types';

@Injectable()
export class ReadTerminologyImpl {
  private readonly logger = new Logger(ReadTerminologyImpl.name);

  constructor(
    private readonly s3Service: S3Service,
    private readonly excelService: ExcelService,
  ) {}

  async execute(
    input: ReadTerminologyInput,
    s3KeyOverride?: string,
  ): Promise<ReadTerminologyOutput> {
    // Terminology is read from the LATEST year's book (the user edits the
    // current book's sheet — a stale default key would serve last year's
    // rules). Explicit override (tests) still pins exactly.
    let key = input?.s3KeyOverride ?? s3KeyOverride;
    if (!key) {
      const keys = await this.s3Service.listWorkbookKeys();
      key = keys.length > 0 ? keys[keys.length - 1] : undefined;
    }
    this.logger.log(
      `Reading terminology lists from S3, key=${key || 'default'}`,
    );

    const workbookBuffer = await this.s3Service.downloadWorkbook(key);
    const workbook = await this.excelService.loadWorkbook(workbookBuffer);
    const terminology = await this.excelService.readTerminology(workbook);

    return {
      forHome: [...terminology.wishlist.forHome],
      personal: [...terminology.wishlist.personal],
      wishlist: [...terminology.wishlist.wishlist],
    };
  }
}
