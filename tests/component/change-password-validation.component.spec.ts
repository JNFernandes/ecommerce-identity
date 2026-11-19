import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { NEW_PASSWORD, passwordState, postChangePassword } from './support/password-flow';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import { FLOW_PASSWORD, LoggedInCustomer, registerAndLogin } from './support/token-flow';

jest.setTimeout(180_000);

const EMAIL = 'validation@example.com';
const GENERIC_401 = { statusCode: 401, message: 'unauthorized', error: 'Unauthorized' };

/**
 * US-12 story 4: validation and access. The rate limit is raised so the many requests here never
 * hit it (story 3 covers the limit).
 */
describe('POST /users/me/password validation and access (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let customer: LoggedInCustomer;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    process.env.RATE_LIMIT_PASSWORD_CHANGE_LIMIT = '1000';
    app = await createTestApp();
    dataSource = app.get(DataSource);
    customer = await registerAndLogin(app, EMAIL);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  /** Sends the body as the customer and checks the status and that nothing changed. */
  async function expectRefused(body: unknown, status: number): Promise<unknown> {
    const before = await passwordState(dataSource, customer.userId);

    const response = await postChangePassword(app, customer.tokens.accessToken, body);

    expect(response.status).toBe(status);
    expect(response.body).not.toHaveProperty('accessToken');
    expect(await passwordState(dataSource, customer.userId)).toEqual(before);
    return response.body;
  }

  it.each([
    ['shorter than 10 characters', 'nine-char'],
    ['longer than 128 characters', 'x'.repeat(129)],
    ['equal to the email ignoring case', EMAIL.toUpperCase()],
    ['equal to the current password', FLOW_PASSWORD],
  ])('should refuse a new password %s with 400', async (_label, newPassword) => {
    await expectRefused({ currentPassword: FLOW_PASSWORD, newPassword }, 400);
  });

  it.each([
    ['a missing currentPassword', { newPassword: NEW_PASSWORD }],
    ['a missing newPassword', { currentPassword: FLOW_PASSWORD }],
    ['an empty newPassword', { currentPassword: FLOW_PASSWORD, newPassword: '' }],
    ['a non-string currentPassword', { currentPassword: 12345678901, newPassword: NEW_PASSWORD }],
    ['a non-string newPassword', { currentPassword: FLOW_PASSWORD, newPassword: ['x'] }],
    [
      'an extra property',
      { currentPassword: FLOW_PASSWORD, newPassword: NEW_PASSWORD, userId: 'someone-else' },
    ],
  ])('should refuse %s with 400', async (_label, body) => {
    await expectRefused(body, 400);
  });

  it('should check the current password first: wrong current and bad new give 401', async () => {
    const body = await expectRefused(
      { currentPassword: 'wrong-password', newPassword: 'short' },
      401,
    );

    expect(body).toMatchObject({ message: 'invalid credentials' });
  });

  it('should refuse a request without a token with 401', async () => {
    const response = await postChangePassword(app, undefined, {
      currentPassword: FLOW_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(GENERIC_401);
  });

  it('should refuse an invalid token with 401', async () => {
    const response = await postChangePassword(app, 'not.a.jwt', {
      currentPassword: FLOW_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(GENERIC_401);
  });

  it('should refuse a disabled user with the generic 401 and change nothing', async () => {
    const disabled = await registerAndLogin(app, 'disabled@example.com');
    await dataSource.query(`UPDATE "users" SET "status" = 'DISABLED' WHERE "id" = $1`, [
      disabled.userId,
    ]);
    const before = await passwordState(dataSource, disabled.userId);

    const response = await postChangePassword(app, disabled.tokens.accessToken, {
      currentPassword: FLOW_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(GENERIC_401);
    expect(await passwordState(dataSource, disabled.userId)).toEqual(before);
  });

  it('should refuse a deleted user with the generic 401', async () => {
    const deleted = await registerAndLogin(app, 'deleted@example.com');
    await dataSource.query('DELETE FROM "refresh_tokens" WHERE "userId" = $1', [deleted.userId]);
    await dataSource.query('DELETE FROM "users" WHERE "id" = $1', [deleted.userId]);

    const response = await postChangePassword(app, deleted.tokens.accessToken, {
      currentPassword: FLOW_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(GENERIC_401);
  });
});
