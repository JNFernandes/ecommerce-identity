import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { EMAIL_MAX_LENGTH } from '../domain/email.value-object';
import { Role } from '../domain/role.enum';
import { UserStatus } from '../domain/user-status.enum';

/** Default page size of `GET /users`. */
export const DEFAULT_USERS_PAGE_LIMIT = 20;

/** Largest page size of `GET /users`. */
export const MAX_USERS_PAGE_LIMIT = 100;

/**
 * Query parameters of `GET /users`. Filters combine with AND. Any other parameter is rejected by
 * the global validation pipe.
 */
export class ListUsersQueryDto {
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

  /** Number of matching users to skip, ≥ 0 (default 0). */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    default: 0,
    description: 'Number of matching users to skip',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;

  /** Only users holding this role. */
  @ApiPropertyOptional({ enum: Role, description: 'Only users holding this role' })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /** Only users with this status. */
  @ApiPropertyOptional({ enum: UserStatus, description: 'Only users with this status' })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  /** Email prefix, case-insensitive and matched literally; an empty value is ignored. */
  @ApiPropertyOptional({
    maxLength: EMAIL_MAX_LENGTH,
    example: 'ana',
    description:
      'Only users whose email starts with this text, ignoring case. `%` and `_` are matched ' +
      'literally. An empty value is ignored.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(EMAIL_MAX_LENGTH)
  email?: string;
}
