import { Module } from '@nestjs/common';
import { ExcelService } from './excel.service';
import { WorkbookRulesService } from './workbook-rules.service';

@Module({
  providers: [ExcelService, WorkbookRulesService],
  exports: [ExcelService, WorkbookRulesService],
})
export class ExcelModule {}
