import { Controller, Get, Headers, Res } from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { JwksResponseDto } from '../dto/jwks-response.dto';
import { JwksService } from '../services/jwks.service';
import { ifNoneMatchMatches } from './if-none-match';
import { onlyThrottlers } from './login-throttle.tracker';
import { Public } from './auth/public.decorator';

/**
 * Public key set endpoint (JWKS). **Public**: no authentication, any `Authorization` header is
 * ignored; not rate limited; never touches Kafka or PostgreSQL. Express answers `HEAD` on the same
 * route with the same headers and no body.
 */
@ApiTags('jwks')
@Public()
@Controller('.well-known')
@onlyThrottlers()
export class JwksController {
  constructor(private readonly jwksService: JwksService) {}

  /**
   * Sends the precomputed key set, so the bytes sent are the bytes the `ETag` hashes. When
   * `If-None-Match` matches the current `ETag`, answers 304 with the same caching headers and no
   * body.
   *
   * @param ifNoneMatch The `If-None-Match` request header, if any.
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
  @ApiResponse({
    status: 304,
    description:
      'Not modified: `If-None-Match` matches the current `ETag`. Same `Cache-Control` and `ETag`, no body',
  })
  @ApiHeader({
    name: 'If-None-Match',
    required: false,
    description: 'An `ETag` from an earlier response, a comma-separated list of them, or `*`',
  })
  getKeySet(@Headers('if-none-match') ifNoneMatch: string | undefined, @Res() res: Response): void {
    const { body, etag, cacheControl } = this.jwksService.current();
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('ETag', etag);
    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      res.status(304);
      res.end();
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  }
}
