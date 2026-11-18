import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RefreshTokenGenerator } from '../../src/services/ports/refresh-token-generator';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import {
  FLOW_PASSWORD,
  LoggedInCustomer,
  postLogout,
  postRefresh,
  registerAndLogin,
  rowOf,
} from './support/token-flow';

jest.setTimeout(180_000);

const LIMIT = 2;
const WINDOW_MS = 60_000;

/**
 * Refresh and logout throttling with a low limit. All Supertest requests come from 127.0.0.1, so
 * they share one IP bucket per throttler.
 */
describe('POST /auth/refresh and /auth/logout rate limits (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let customer: LoggedInCustomer;
  let hash: jest.SpyInstance;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    process.env.RATE_LIMIT_REFRESH_LIMIT = String(LIMIT);
    process.env.RATE_LIMIT_REFRESH_TTL_MS = String(WINDOW_MS);
    process.env.RATE_LIMIT_LOGOUT_LIMIT = String(LIMIT);
    process.env.RATE_LIMIT_LOGOUT_TTL_MS = String(WINDOW_MS);
    app = await createTestApp();
    dataSource = app.get(DataSource);
    customer = await registerAndLogin(app, 'throttle@example.com');
    hash = jest.spyOn(app.get(RefreshTokenGenerator), 'hash');
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should answer the refresh after the limit with 429 without looking the token up', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      statuses.push((await postRefresh(app, `unknown-token-${attempt}`)).status);
    }
    hash.mockClear();

    const blocked = await postRefresh(app, customer.tokens.refreshToken);

    expect(statuses).toEqual(Array<number>(LIMIT).fill(401));
    expect(blocked.status).toBe(429);
    expect(hash).not.toHaveBeenCalled();
    expect((await rowOf(dataSource, customer.tokens.refreshToken))?.revokedAt).toBeNull();
  });

  it('should not let refresh traffic consume the login bucket', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'throttle@example.com', password: FLOW_PASSWORD });

    expect(response.status).toBe(200);
  });

  it('should answer the logout after the limit with 429 and leave the session alive', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      statuses.push((await postLogout(app, `unknown-token-${attempt}`)).status);
    }
    hash.mockClear();

    const blocked = await postLogout(app, customer.tokens.refreshToken);

    expect(statuses).toEqual(Array<number>(LIMIT).fill(204));
    expect(blocked.status).toBe(429);
    expect(hash).not.toHaveBeenCalled();
    expect((await rowOf(dataSource, customer.tokens.refreshToken))?.revokedAt).toBeNull();
  });
});
