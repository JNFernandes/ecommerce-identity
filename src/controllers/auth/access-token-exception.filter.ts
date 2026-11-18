import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { InvalidAccessTokenError } from '../../domain/errors/invalid-access-token.error';

/** The body of every 401 caused by an access token. Identical for every reason. */
export const UNAUTHORIZED_BODY = {
  statusCode: HttpStatus.UNAUTHORIZED,
  message: 'unauthorized',
  error: 'Unauthorized',
} as const;

/**
 * The single place that turns an {@link InvalidAccessTokenError} into HTTP: 401 with
 * `WWW-Authenticate: Bearer` and a fixed body, so every refused token gets a byte-identical
 * response. The reason is logged at `warn`; the token and the header are never logged.
 */
@Catch(InvalidAccessTokenError)
export class AccessTokenExceptionFilter implements ExceptionFilter<InvalidAccessTokenError> {
  private readonly logger = new Logger(AccessTokenExceptionFilter.name);

  /**
   * Writes the generic 401.
   *
   * @param error The refused token error.
   * @param host The arguments host of the current request.
   */
  catch(error: InvalidAccessTokenError, host: ArgumentsHost): void {
    this.logger.warn(`access token refused: reason=${error.reason}`);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.UNAUTHORIZED)
      .setHeader('WWW-Authenticate', 'Bearer')
      .json(UNAUTHORIZED_BODY);
  }
}
