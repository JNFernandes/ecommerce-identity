import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { NEW_PASSWORD, passwordState, postChangePassword } from './support/password-flow';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import { FLOW_PASSWORD, LoggedInCustomer, registerAndLogin } from './support/token-flow';

jest.setTimeout(180_000);

/** The default limit (5 per minute), left unconfigured on purpose. */
const LIMIT = 5;

/**
 * US-12 story 3: wrong current password and guessing protection, with the default limit. All
 * Supertest requests come from 127.0.0.1, so the buckets differ only by user.
 */
describe('POST /users/me/password guessing protection (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let victim: LoggedInCustomer;
  let bystander: LoggedInCustomer;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    delete process.env.RATE_LIMIT_PASSWORD_CHANGE_LIMIT;
    delete process.env.RATE_LIMIT_PASSWORD_CHANGE_TTL_MS;
    app = await createTestApp();
    dataSource = app.get(DataSource);
    victim = await registerAndLogin(app, 'victim@example.com');
    bystander = await registerAndLogin(app, 'bystander@example.com');
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  const guess = (accessToken: string, currentPassword: string): request.Test =>
    postChangePassword(app, accessToken, { currentPassword, newPassword: NEW_PASSWORD });

  it('should answer a wrong current password with the generic 401 and change nothing', async () => {
    const before = await passwordState(dataSource, victim.userId);

    const response = await guess(victim.tokens.accessToken, 'wrong-password-1');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      message: 'invalid credentials',
      error: 'Unauthorized',
    });
    expect(response.body).not.toHaveProperty('accessToken');
    expect(await passwordState(dataSource, victim.userId)).toEqual(before);
  });

  it('should refuse the attempt after the limit with 429, even with the right password', async () => {
    // One attempt was already spent by the previous test.
    for (let attempt = 2; attempt <= LIMIT; attempt += 1) {
      expect((await guess(victim.tokens.accessToken, `wrong-password-${attempt}`)).status).toBe(
        401,
      );
    }
    const before = await passwordState(dataSource, victim.userId);

    const blocked = await guess(victim.tokens.accessToken, FLOW_PASSWORD);

    expect(blocked.status).toBe(429);
    expect(await passwordState(dataSource, victim.userId)).toEqual(before);
  });

  it('should not block a different user calling from the same address', async () => {
    const response = await guess(bystander.tokens.accessToken, FLOW_PASSWORD);

    expect(response.status).toBe(200);
  });

  it('should leave login open to the blocked user, with the unchanged password', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'victim@example.com', password: FLOW_PASSWORD });

    expect(response.status).toBe(200);
  });
});
