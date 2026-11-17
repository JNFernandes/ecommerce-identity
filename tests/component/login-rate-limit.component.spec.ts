import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PasswordHasher } from '../../src/services/ports/password-hasher';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';

jest.setTimeout(180_000);

const PASSWORD = 'correct-horse-battery';
const LIMIT = 3;
const WINDOW_MS = 3000;

/** Waits for the given number of milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Login throttling with a low limit. All Supertest requests come from 127.0.0.1, so the IP and
 * email buckets fill together here; keying by email across IPs is covered by the tracker unit test.
 */
describe('POST /auth/login rate limit (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let verify: jest.SpyInstance;

  const login = (password: string): request.Test =>
    request(app.getHttpServer()).post('/auth/login').send({ email: 'ana@example.com', password });

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    process.env.RATE_LIMIT_LOGIN_LIMIT = String(LIMIT);
    process.env.RATE_LIMIT_LOGIN_TTL_MS = String(WINDOW_MS);
    app = await createTestApp();
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'ana@example.com', name: 'Ana', password: PASSWORD });
    expect(registered.status).toBe(201);
    verify = jest.spyOn(app.get(PasswordHasher), 'verify');
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should process requests up to the limit, then answer 429 without checking credentials', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      statuses.push((await login('wrong-password-123')).status);
    }
    const blocked = await login(PASSWORD);

    expect(statuses).toEqual(Array<number>(LIMIT).fill(401));
    expect(blocked.status).toBe(429);
    expect(verify).toHaveBeenCalledTimes(LIMIT);
  });

  it('should not affect registration from the same IP', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'bob@example.com', name: 'Bob', password: PASSWORD });

    expect(response.status).toBe(201);
  });

  it('should accept requests again once the window has passed', async () => {
    await wait(WINDOW_MS + 500);

    const response = await login(PASSWORD);

    expect(response.status).toBe(200);
  });
});
