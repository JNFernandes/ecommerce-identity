import { ApiProperty } from '@nestjs/swagger';
import { UserPageReadModel } from '../queries/user-summary.read-model';
import { UserSummaryResponseDto } from './user-summary-response.dto';

/** Response of `GET /users`: one page of users, newest first, with the total of matching users. */
export class UserPageResponseDto {
  @ApiProperty({
    type: UserSummaryResponseDto,
    isArray: true,
    description: 'Users of the page, newest first',
  })
  items!: UserSummaryResponseDto[];

  @ApiProperty({ type: 'integer', example: 42, description: 'Users matching the filters' })
  total!: number;

  @ApiProperty({ type: 'integer', example: 20, description: 'Page size applied' })
  limit!: number;

  @ApiProperty({ type: 'integer', example: 0, description: 'Matching users skipped' })
  offset!: number;

  /**
   * Maps a page read model to the response.
   *
   * @param page The page.
   */
  static from(page: UserPageReadModel): UserPageResponseDto {
    const dto = new UserPageResponseDto();
    dto.items = page.items.map((item) => UserSummaryResponseDto.from(item));
    dto.total = page.total;
    dto.limit = page.limit;
    dto.offset = page.offset;
    return dto;
  }
}
