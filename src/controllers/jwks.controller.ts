import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { JwksResponseDto } from '../dto/jwks-response.dto';
import { JwksService } from '../services/jwks.service';
import { REGISTER_THROTTLER } from './auth.controller';
import { LOGIN_EMAIL_THROTTLER, LOGIN_IP_THROTTLER } from './login-throttle.tracker';

/**
 * Public key set endpoint (JWKS). **Public**: no authentication, any `Authorization` header is
 * ignored; not rate limited; never touches Kafka or PostgreSQL. Express answers `HEAD` on the same
 * route with the same headers and no body.
 */
@ApiTags('jwks')
@Controller('.well-known')
@SkipThrottle({
  [REGISTER_THROTTLER]: true,
  [LOGIN_IP_THROTTLER]: true,
  [LOGIN_EMAIL_THROTTLER]: true,
})
export class JwksController {
  constructor(private readonly jwksService: JwksService) {}

  /**
   * Sends the precomputed key set, so the bytes sent are the bytes the `ETag` hashes.
   *
   * @param res The Express response, written directly.
   */
  @Get('jwks.json')
  @ApiOperation({
    summary: 'Public keys for verifying access tokens',
    description:
      'Active signing key first, then retired keys still accepted. Public, not rate limited. Select the key by the token `kid` header.',
  })
  @ApiProduces('application/json')
  @ApiOkResponse({
    type: JwksResponseDto,
    description: 'The key set, with `Cache-Control: public, max-age=<n>` and a strong `ETag`',
  })
  getKeySet(@Res() res: Response): void {
    const { body, etag, cacheControl } = this.jwksService.current();
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('ETag', etag);
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  }
}
