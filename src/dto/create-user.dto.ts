import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { Role } from '../domain/role.enum';

/**
 * Body of `POST /users` (admins only). Email, name and password follow the registration rules,
 * applied by the domain; `roles` holds exactly one role. Any other property (`id`, `customerId`,
 * `status`, …) is rejected by the global validation pipe, so the server owns those fields.
 */
export class CreateUserDto {
  /** Email address; trimmed and lowercased by the domain. */
  @ApiProperty({ example: 'bea@example.com', description: 'Email, unique case-insensitively' })
  @IsString()
  @IsNotEmpty()
  email!: string;

  /** Display name, 1–100 characters after trimming. */
  @ApiProperty({ example: 'Bea', description: 'Display name, 1–100 characters after trimming' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  /** Initial plain password chosen by the admin, 10–128 characters, not equal to the email. */
  @ApiProperty({
    example: 'correct-horse-battery',
    description:
      'Initial password, 10–128 characters, must not equal the email. The admin knows it: the ' +
      'user should change it with POST /users/me/password after the first login.',
    format: 'password',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;

  /** Exactly one role: `["CUSTOMER"]` or `["ADMIN"]`. */
  @ApiProperty({
    enum: Role,
    isArray: true,
    example: [Role.ADMIN],
    description: 'Exactly one role: ["CUSTOMER"] or ["ADMIN"]',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @IsEnum(Role, { each: true })
  roles!: Role[];
}
