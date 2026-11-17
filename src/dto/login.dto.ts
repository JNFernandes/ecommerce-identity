import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /auth/login`. Only shape is checked here: no password policy is applied at login,
 * so a policy change never locks out existing users. Any other property is rejected by the global
 * validation pipe.
 */
export class LoginDto {
  /** Email address; trimmed and lowercased by the domain. */
  @ApiProperty({ example: 'ana@example.com', description: 'Email, case-insensitive' })
  @IsString()
  @IsNotEmpty()
  email!: string;

  /** Plain password, used exactly as sent (never trimmed). */
  @ApiProperty({
    example: 'correct-horse-battery',
    description: 'Password, used exactly as sent',
    format: 'password',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
