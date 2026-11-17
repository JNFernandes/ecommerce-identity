import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../domain/role.enum';
import { User } from '../domain/user.aggregate';

/** Response of `POST /auth/register`. Never carries a password, hash or token. */
export class RegisterResponseDto {
  @ApiProperty({ format: 'uuid', description: 'User id' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'Customer id, different from the user id' })
  customerId!: string;

  @ApiProperty({ example: 'ana@example.com', description: 'Normalized email' })
  email!: string;

  @ApiProperty({ example: 'Ana', description: 'Trimmed display name' })
  name!: string;

  @ApiProperty({ enum: Role, isArray: true, example: [Role.CUSTOMER] })
  roles!: Role[];

  @ApiProperty({ format: 'date-time', description: 'Creation time (ISO 8601)' })
  createdAt!: string;

  /**
   * Maps a registered customer to the response, keeping only the public fields.
   *
   * @param user A user with the customer role.
   */
  static fromUser(user: User): RegisterResponseDto {
    const dto = new RegisterResponseDto();
    dto.id = user.id;
    dto.customerId = user.customerId ?? '';
    dto.email = user.email.value;
    dto.name = user.name.value;
    dto.roles = user.roles;
    dto.createdAt = user.createdAt.toISOString();
    return dto;
  }
}
