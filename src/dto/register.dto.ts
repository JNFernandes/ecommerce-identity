import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /auth/register`. Only shape is checked here; the domain applies the email, name
 * and password rules. Any other property is rejected by the global validation pipe.
 */
export class RegisterDto {
  /** Email address; trimmed and lowercased by the domain. */
  @ApiProperty({ example: 'ana@example.com', description: 'Email, unique case-insensitively' })
  @IsString()
  @IsNotEmpty()
  email!: string;

  /** Display name, 1–100 characters after trimming. */
  @ApiProperty({ example: 'Ana', description: 'Display name, 1–100 characters after trimming' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  /** Plain password, 10–128 characters, not equal to the email. */
  @ApiProperty({
    example: 'correct-horse-battery',
    description: 'Password, 10–128 characters, must not equal the email',
    format: 'password',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
