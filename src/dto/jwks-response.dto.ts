import { ApiProperty } from '@nestjs/swagger';

/**
 * One published RS256 public key (RFC 7517). Exactly these six members; private parameters are
 * never published.
 */
export class JwkDto {
  @ApiProperty({ enum: ['RSA'], example: 'RSA', description: 'Key type' })
  kty!: 'RSA';

  @ApiProperty({ enum: ['sig'], example: 'sig', description: 'Public key use: signatures' })
  use!: 'sig';

  @ApiProperty({ enum: ['RS256'], example: 'RS256', description: 'The only accepted algorithm' })
  alg!: 'RS256';

  @ApiProperty({
    description:
      'Key id: RFC 7638 SHA-256 thumbprint, equal to the `kid` header of tokens signed with this key',
    example: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
  })
  kid!: string;

  @ApiProperty({ description: 'RSA modulus, base64url', example: '0vx7agoebGcQSuu…' })
  n!: string;

  @ApiProperty({ description: 'RSA public exponent, base64url', example: 'AQAB' })
  e!: string;
}

/**
 * Response of `GET /.well-known/jwks.json`: the active signing key first, then retired keys still
 * accepted for verification, in configured order.
 */
export class JwksResponseDto {
  @ApiProperty({ type: [JwkDto], description: 'Active key first, then retired keys' })
  keys!: JwkDto[];
}
