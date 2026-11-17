import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { DEFAULT_PORT } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  configureApp(app);
  // Run shutdown hooks on SIGTERM/SIGINT so the Kafka producer disconnects cleanly.
  app.enableShutdownHooks();

  const port = app.get(ConfigService).get<number>('port') ?? DEFAULT_PORT;
  await app.listen(port);
}

bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error('Failed to start ecommerce-identity', error);
  process.exit(1);
});
