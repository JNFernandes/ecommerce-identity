import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';

jest.setTimeout(180_000);

const LIMIT = 5;

describe('POST /auth/register rate limit (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;

  const countUsers = async (): Promise<number> => {
    const rows: { count: string }[] = await app
      .get(DataSource)
      .query('SELECT count(*) AS "count" FROM "users"');
    return Number(rows[0].count);
  };

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    process.env.RATE_LIMIT_REGISTER_LIMIT = String(LIMIT);
    process.env.RATE_LIMIT_REGISTER_TTL_MS = '60000';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should process the first 5 registrations from one IP and reject the 6th with 429', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= LIMIT; i++) {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: `user${i}@example.com`, name: 'Ana', password: 'correct-horse-battery' });
      statuses.push(response.status);
    }
    expect(statuses).toEqual(Array<number>(LIMIT).fill(201));

    const sixth = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'user6@example.com', name: 'Ana', password: 'correct-horse-battery' });

    expect(sixth.status).toBe(429);
    expect(await countUsers()).toBe(LIMIT);
  });

  it('should never throttle GET /health', async () => {
    for (let i = 0; i < LIMIT + 2; i++) {
      const response = await request(app.getHttpServer()).get('/health');
      expect(response.status).toBe(200);
    }
  });
});
