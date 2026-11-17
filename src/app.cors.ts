import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/** Methods a cross-origin caller may use. */
export const CORS_ALLOWED_METHODS: readonly string[] = ['GET', 'POST', 'PATCH', 'OPTIONS'];

/** Request headers a cross-origin caller may send. */
export const CORS_ALLOWED_HEADERS: readonly string[] = ['Content-Type', 'Authorization'];

/**
 * CORS options, or `null` when no origin is allowed (CORS stays off, as it is without
 * `CORS_ALLOWED_ORIGINS`).
 *
 * Origins are matched exactly; wildcards are never used. A request from any other origin, or
 * without an `Origin` header, gets no CORS headers at all. Credentials are not allowed.
 */
export function buildCorsOptions(allowedOrigins: readonly string[]): CorsOptions | null {
  if (allowedOrigins.length === 0) {
    return null;
  }
  const allowed = new Set(allowedOrigins);
  return {
    origin: (requestOrigin, callback): void => {
      callback(null, requestOrigin !== undefined && allowed.has(requestOrigin));
    },
    methods: [...CORS_ALLOWED_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    credentials: false,
  };
}
