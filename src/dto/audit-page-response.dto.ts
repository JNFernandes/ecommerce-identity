import { ApiProperty } from '@nestjs/swagger';
import { AuditPageReadModel } from '../queries/audit-record.read-model';
import { AuditRecordResponseDto } from './audit-record-response.dto';

/** Response of `GET /audit`: one page of records, newest first, with the total of matches. */
export class AuditPageResponseDto {
  @ApiProperty({
    type: AuditRecordResponseDto,
    isArray: true,
    description: 'Records of the page, newest first',
  })
  items!: AuditRecordResponseDto[];

  @ApiProperty({ type: 'integer', example: 42, description: 'Records matching the filters' })
  total!: number;

  @ApiProperty({ type: 'integer', example: 20, description: 'Page size applied' })
  limit!: number;

  @ApiProperty({ type: 'integer', example: 0, description: 'Matching records skipped' })
  offset!: number;

  /**
   * Maps a page read model to the response.
   *
   * @param page The page.
   */
  static from(page: AuditPageReadModel): AuditPageResponseDto {
    const dto = new AuditPageResponseDto();
    dto.items = page.items.map((item) => AuditRecordResponseDto.from(item));
    dto.total = page.total;
    dto.limit = page.limit;
    dto.offset = page.offset;
    return dto;
  }
}
