import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { UserStatus } from '../domain/user-status.enum';

/**
 * Body of `PATCH /users/{id}/status`. Any other field is rejected by the global validation pipe.
 */
export class ChangeUserStatusDto {
  /** The status the user must have after the request: `ACTIVE` or `DISABLED`, exact case. */
  @ApiProperty({
    enum: UserStatus,
    example: UserStatus.DISABLED,
    description: 'The status the user must have after the request',
  })
  @IsEnum(UserStatus)
  status!: UserStatus;
}
