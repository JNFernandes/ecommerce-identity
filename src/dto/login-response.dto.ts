import { ApiProperty } from '@nestjs/swagger';
import { LoginResult } from '../services/login.service';

/** Response of `POST /auth/login`. Both tokens are secrets; the refresh token is shown only here. */
export class LoginResponseDto {
  @ApiProperty({ description: 'RS256 access token (JWT)', example: 'eyJhbGciOiJSUzI1NiIs…' })
  accessToken!: string;

  @ApiProperty({
    description: 'Opaque refresh token, 43 base64url characters; cannot be recovered later',
    example: 'q8XvQm3…',
  })
  refreshToken!: string;

  @ApiProperty({ enum: ['Bearer'], example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({ description: 'Access token lifetime in seconds', example: 900 })
  expiresIn!: number;

  /**
   * Maps a login result to the response, keeping exactly the four fields.
   *
   * @param result The handler's result.
   */
  static fromResult(result: LoginResult): LoginResponseDto {
    const dto = new LoginResponseDto();
    dto.accessToken = result.accessToken;
    dto.refreshToken = result.refreshToken;
    dto.tokenType = result.tokenType;
    dto.expiresIn = result.expiresIn;
    return dto;
  }
}
