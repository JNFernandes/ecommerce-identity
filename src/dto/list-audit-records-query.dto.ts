import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AuditAction } from '../domain/audit/audit-action.enum';
import { DEFAULT_USERS_PAGE_LIMIT, MAX_USERS_PAGE_LIMIT } from './list-users-query.dto';

/**
 * Query parameters of `GET /audit`. Filters combine with AND. A repeated parameter arrives as an
 * array and fails validation; any other parameter is rejected by the global validation pipe.
 */
export class ListAuditRecordsQueryDto {
  /** Page size, 1–100 (default 20). */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_USERS_PAGE_LIMIT,
    default: DEFAULT_USERS_PAGE_LIMIT,
    description: 'Page size',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_USERS_PAGE_LIMIT)
  limit: number = DEFAULT_USERS_PAGE_LIMIT;

  /** Number of matching records to skip, ≥ 0 (default 0). */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    default: 0,
    description: 'Number of matching records to skip',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;

  /** Only records written by this admin. */
  @ApiPropertyOptional({ format: 'uuid', description: 'Only records written by this admin' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  /** Only records about this user. */
  @ApiPropertyOptional({ format: 'uuid', description: 'Only records about this user' })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  /** Only records of this action. */
  @ApiPropertyOptional({ enum: AuditAction, description: 'Only records of this action' })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;
}
