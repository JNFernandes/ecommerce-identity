import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CorsConfig } from './config/configuration';
import { buildCorsOptions } from './app.cors';

/**
 * Application-wide setup shared by `main.ts` and the tests, so tests validate input exactly as
 * production does.
 *
 * - CORS is enabled only when `CORS_ALLOWED_ORIGINS` lists at least one origin.
 * - A global ValidationPipe rejects unknown properties (`whitelist` + `forbidNonWhitelisted`) and
 *   transforms payloads into DTO instances.
 */
export function configureApp(app: INestApplication): void {
  const allowedOrigins = app.get(ConfigService).get<CorsConfig>('cors')?.allowedOrigins ?? [];
  const corsOptions = buildCorsOptions(allowedOrigins);
  if (corsOptions !== null) {
    app.enableCors(corsOptions);
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
