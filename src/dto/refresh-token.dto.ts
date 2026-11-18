import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /auth/refresh` and `POST /auth/logout`: the opaque refresh token from login or the
 * last refresh. The length cap stops huge values from being hashed. Any other property is rejected
 * by the global validation pipe.
 */
export class RefreshTokenDto {
  /** The opaque refresh token (43 base64url characters when issued by this service). */
  @ApiProperty({
    example: 'q8Xv3mN0pQ7rS2tU5wY9zA1bC4dE6fG8hJ0kL2mN4pQ',
    description: 'Opaque refresh token from login or the last refresh',
    maxLength: 512,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  refreshToken!: string;
}
