import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /users/me/password`. Only shape is checked here; the length, "not the email" and
 * "differs from the current one" rules live in the domain and apply only after the current
 * password is verified. Any other property is rejected by the global validation pipe.
 */
export class ChangePasswordDto {
  /** The current password, used exactly as sent (never trimmed). */
  @ApiProperty({
    example: 'correct-horse-battery',
    description: 'Current password, used exactly as sent',
    format: 'password',
  })
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  /** The new password, used exactly as sent (never trimmed). */
  @ApiProperty({
    example: 'a-brand-new-passphrase',
    description:
      'New password: 10 to 128 characters, not the email (ignoring case), different from the ' +
      'current one',
    format: 'password',
    minLength: 10,
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  newPassword!: string;
}
