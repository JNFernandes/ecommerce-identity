import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '../domain/role.enum';
import { UserStatus } from '../domain/user-status.enum';
import { UserSummaryReadModel } from '../queries/user-summary.read-model';

/**
 * One user as returned to admins by `GET /users` and `GET /users/{id}`. An explicit allow-list:
 * never carries a password, hash or `updatedAt`.
 */
export class UserSummaryResponseDto {
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

  @ApiProperty({ enum: Role, isArray: true, example: [Role.CUSTOMER], description: 'Roles' })
  roles!: Role[];

  @ApiProperty({ enum: UserStatus, example: UserStatus.ACTIVE, description: 'Account status' })
  status!: UserStatus;

  @ApiProperty({ format: 'date-time', description: 'Creation time (ISO 8601)' })
  createdAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Time of the last successful login (ISO 8601); null until the first login',
  })
  lastLoginAt!: string | null;

  /**
   * Maps the read model to the response, leaving `customerId` out when the user has none.
   *
   * @param model The user.
   */
  static from(model: UserSummaryReadModel): UserSummaryResponseDto {
    const dto = new UserSummaryResponseDto();
    dto.id = model.id;
    if (model.customerId !== null) {
      dto.customerId = model.customerId;
    }
    dto.email = model.email;
    dto.name = model.name;
    dto.roles = [...model.roles];
    dto.status = model.status;
    dto.createdAt = model.createdAt.toISOString();
    dto.lastLoginAt = model.lastLoginAt === null ? null : model.lastLoginAt.toISOString();
    return dto;
  }
}
