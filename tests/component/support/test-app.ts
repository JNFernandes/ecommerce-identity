import { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo, createServer } from 'net';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AppModule } from '../../../src/app.module';
import { configureApp } from '../../../src/app.setup';

/** Returns a local port with nothing listening on it, so a client pointed there fails fast. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Starts a PostgreSQL container and points the app's `DATABASE_*` settings at it (migrations run
 * on startup). Also sets low argon2 parameters so registrations stay fast.
 */
export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_HOST = container.getHost();
  process.env.DATABASE_PORT = String(container.getPort());
  process.env.DATABASE_NAME = container.getDatabase();
  process.env.DATABASE_USER = container.getUsername();
  process.env.DATABASE_PASSWORD = container.getPassword();
  process.env.DATABASE_MIGRATIONS_RUN = 'true';
  process.env.ARGON2_MEMORY_COST_KIB = '1024';
  process.env.ARGON2_TIME_COST = '2';
  process.env.ARGON2_PARALLELISM = '1';
  return container;
}

/**
 * Points Kafka at a closed local port with no retries and a short connection timeout, so every
 * publish fails within a fraction of a second (never the developer's `localhost:9092`).
 */
export async function useUnreachableKafka(): Promise<void> {
  process.env.KAFKA_BROKERS = `127.0.0.1:${await closedPort()}`;
  process.env.KAFKA_PRODUCER_RETRIES = '0';
  process.env.KAFKA_CONNECTION_TIMEOUT_MS = '200';
}

/** Builds and initializes the full application exactly as `main.ts` configures it. */
export async function createTestApp(logger?: LoggerService): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  if (logger !== undefined) {
    moduleRef.useLogger(logger);
  }
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}
