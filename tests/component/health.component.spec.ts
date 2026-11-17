import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AddressInfo, createServer } from 'net';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { configureSwagger } from '../../src/app.swagger';
import { useTestSigningKey } from './support/test-app';

jest.setTimeout(180_000);

/** Startup must not wait for Kafka: it has to finish well under this. */
const PROMPT_MS = 10_000;

/** Returns a local port with nothing listening on it, so Kafka is unreachable. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('GET /health (component, Kafka not running)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let startupMs: number;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_HOST = container.getHost();
    process.env.DATABASE_PORT = String(container.getPort());
    process.env.DATABASE_NAME = container.getDatabase();
    process.env.DATABASE_USER = container.getUsername();
    process.env.DATABASE_PASSWORD = container.getPassword();
    process.env.DATABASE_MIGRATIONS_RUN = 'true';
    process.env.KAFKA_BROKERS = `127.0.0.1:${await closedPort()}`;
    useTestSigningKey();

    const started = Date.now();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    configureSwagger(app);
    await app.init();
    startupMs = Date.now() - started;
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should start promptly without Kafka', () => {
    expect(startupMs).toBeLessThan(PROMPT_MS);
  });

  it('should report ok with the database up and Kafka not failing the check', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({ status: 'ok', database: 'up', kafka: 'idle' });
  });

  it('should have applied the baseline migration at startup', async () => {
    const rows: { name: string }[] = await app.get(DataSource).query('SELECT name FROM migrations');

    expect(rows.map((row) => row.name)).toContain('Baseline20261117120000');
  });

  it('should serve the OpenAPI document with the health endpoint', async () => {
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    expect(Object.keys(response.body.paths as Record<string, unknown>)).toContain('/health');
  });
});
