import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '../domain/role.enum';
import { UserStatus } from '../domain/user-status.enum';
import { CurrentUserReadModel } from '../services/get-current-user.service';

/**
 * Response of `GET /users/me`: the caller's account as stored now. Never carries a password, hash,
 * token, `updatedAt` or `lastLoginAt`.
 */
export class CurrentUserResponseDto {
  @ApiProperty({ format: 'uuid', description: 'User id' })
  id!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Customer id. Present for customers only; left out entirely for admins.',
  })
  customerId?: string;

  @ApiProperty({ example: 'ana@example.com', description: 'Normalized email' })
  email!: string;

  @ApiProperty({ example: 'Ana', description: 'Display name' })
  name!: string;

  @ApiProperty({
    enum: Role,
    isArray: true,
    example: [Role.CUSTOMER],
    description: 'Current stored roles (not the token claims)',
  })
  roles!: Role[];

  @ApiProperty({
    enum: UserStatus,
    example: UserStatus.ACTIVE,
    description: 'Account status; always ACTIVE in a 200 response',
  })
  status!: UserStatus;

  @ApiProperty({ format: 'date-time', description: 'Creation time (ISO 8601)' })
  createdAt!: string;

  /**
   * Maps the read model to the response, leaving `customerId` out when the user has none.
   *
   * @param model The caller's account.
   */
  static from(model: CurrentUserReadModel): CurrentUserResponseDto {
    const dto = new CurrentUserResponseDto();
    dto.id = model.id;
    if (model.customerId !== null) {
      dto.customerId = model.customerId;
    }
    dto.email = model.email;
    dto.name = model.name;
    dto.roles = [...model.roles];
    dto.status = model.status;
    dto.createdAt = model.createdAt.toISOString();
    return dto;
  }
}
