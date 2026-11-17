import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AddressInfo, createServer } from 'net';
import request from 'supertest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { CapturingLogger } from './support/capturing-logger';

jest.setTimeout(180_000);

const PASSWORD = 'correct-horse-battery';

/** Returns a local port with nothing listening on it, so Kafka is unreachable. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface UserRow {
  id: string;
  customerId: string;
  email: string;
  name: string;
  passwordHash: string;
  roles: string;
  status: string;
}

describe('POST /auth/register (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let response: request.Response;
  let row: UserRow;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_HOST = container.getHost();
    process.env.DATABASE_PORT = String(container.getPort());
    process.env.DATABASE_NAME = container.getDatabase();
    process.env.DATABASE_USER = container.getUsername();
    process.env.DATABASE_PASSWORD = container.getPassword();
    process.env.DATABASE_MIGRATIONS_RUN = 'true';
    process.env.KAFKA_BROKERS = `127.0.0.1:${await closedPort()}`;
    process.env.ARGON2_MEMORY_COST_KIB = '1024';
    process.env.ARGON2_TIME_COST = '2';
    process.env.ARGON2_PARALLELISM = '1';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    moduleRef.useLogger(logger);
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'Ana@Example.com ', name: 'Ana', password: PASSWORD });
    const rows: UserRow[] = await app
      .get(DataSource)
      .query(
        'SELECT "id", "customerId", "email", "name", "passwordHash", "roles"::text AS "roles", "status" FROM "users"',
      );
    row = rows[0];
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should return 201 with exactly the six public fields', () => {
    expect(response.status).toBe(201);
    expect(Object.keys(response.body as object).sort()).toEqual(
      ['createdAt', 'customerId', 'email', 'id', 'name', 'roles'].sort(),
    );
    expect(response.body).toMatchObject({
      email: 'ana@example.com',
      name: 'Ana',
      roles: ['CUSTOMER'],
    });
  });

  it('should store an ACTIVE customer with its own customerId and an argon2id hash', () => {
    expect(row).toBeDefined();
    expect(row.id).toBe(response.body.id);
    expect(row.customerId).toBe(response.body.customerId);
    expect(row.customerId).not.toBe(row.id);
    expect(row.email).toBe('ana@example.com');
    expect(row.status).toBe('ACTIVE');
    expect(row.roles).toBe('{CUSTOMER}');
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('should return no password, hash or token', () => {
    const body = JSON.stringify(response.body);

    for (const key of ['password', 'passwordHash', 'accessToken', 'refreshToken']) {
      expect(response.body).not.toHaveProperty(key);
    }
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain(row.passwordHash);
  });

  it('should log neither the password nor the hash', () => {
    expect(logger.lines.length).toBeGreaterThan(0);
    expect(logger.text()).not.toContain(PASSWORD);
    expect(logger.text()).not.toContain(row.passwordHash);
  });
});
