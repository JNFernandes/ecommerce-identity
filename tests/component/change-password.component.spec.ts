import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapturingLogger } from './support/capturing-logger';
import { NEW_PASSWORD, passwordState, postChangePassword } from './support/password-flow';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import {
  FLOW_PASSWORD,
  insertAdminAndLogin,
  loginAs,
  postRefresh,
  registerAndLogin,
  TokenPair,
} from './support/token-flow';

jest.setTimeout(180_000);

/**
 * US-12 stories 1 and 2 against real PostgreSQL. Kafka is unreachable for the whole suite, so every
 * success here also shows the endpoint never needs the broker (FR-010).
 */
describe('POST /users/me/password (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  const secrets: string[] = [FLOW_PASSWORD, NEW_PASSWORD];

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    app = await createTestApp(logger);
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  const me = (accessToken: string): request.Test =>
    request(app.getHttpServer()).get('/users/me').set('Authorization', `Bearer ${accessToken}`);

  const login = (email: string, password: string): request.Test =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password });

  /** Changes the password with the given access token; fails the test unless it returns 200. */
  async function change(accessToken: string): Promise<TokenPair> {
    const response = await postChangePassword(app, accessToken, {
      currentPassword: FLOW_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.status).toBe(200);
    const pair = response.body as TokenPair;
    secrets.push(pair.accessToken, pair.refreshToken);
    return pair;
  }

  describe('US1: change my password and stay signed in', () => {
    let userId: string;
    let before: TokenPair;
    let after: TokenPair;

    beforeAll(async () => {
      const customer = await registerAndLogin(app, 'change@example.com');
      userId = customer.userId;
      before = customer.tokens;
      secrets.push(before.accessToken, before.refreshToken);
      secrets.push((await passwordState(dataSource, userId)).passwordHash);
      after = await change(before.accessToken);
      secrets.push((await passwordState(dataSource, userId)).passwordHash);
    });

    it('should return a new pair in the login shape', () => {
      expect(Object.keys(after).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshToken',
        'tokenType',
      ]);
      expect(after.tokenType).toBe('Bearer');
      expect(after.expiresIn).toBeGreaterThan(0);
      expect(after.accessToken).not.toBe(before.accessToken);
      expect(after.refreshToken).not.toBe(before.refreshToken);
    });

    it('should accept the new password at login and refuse the old one', async () => {
      expect((await login('change@example.com', NEW_PASSWORD)).status).toBe(200);
      const old = await login('change@example.com', FLOW_PASSWORD);
      expect(old.status).toBe(401);
      expect(old.body).toMatchObject({ message: 'invalid credentials' });
    });

    it('should let the new access token reach the account', async () => {
      const response = await me(after.accessToken);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: userId });
    });

    it('should rotate the returned refresh token normally', async () => {
      const rotated = await postRefresh(app, after.refreshToken);
      expect(rotated.status).toBe(200);
      secrets.push(
        (rotated.body as TokenPair).accessToken,
        (rotated.body as TokenPair).refreshToken,
      );

      expect((await postRefresh(app, after.refreshToken)).status).toBe(401);
    });
  });

  it('US1: should change an admin password and keep the admin roles', async () => {
    const admin = await insertAdminAndLogin(app, 'admin-change@example.com');
    secrets.push(admin.tokens.accessToken, admin.tokens.refreshToken);

    const pair = await change(admin.tokens.accessToken);

    const response = await me(pair.accessToken);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: admin.userId, roles: ['ADMIN'] });
    expect(response.body).not.toHaveProperty('customerId');
    secrets.push((await loginAs(app, 'admin-change@example.com', NEW_PASSWORD)).refreshToken);
  });

  describe('US2: other sessions end', () => {
    let first: TokenPair;
    let second: TokenPair;
    let returned: TokenPair;

    beforeAll(async () => {
      first = (await registerAndLogin(app, 'sessions@example.com')).tokens;
      second = await loginAs(app, 'sessions@example.com', FLOW_PASSWORD);
      secrets.push(first.accessToken, first.refreshToken, second.accessToken, second.refreshToken);
      returned = await change(first.accessToken);
    });

    it.each([
      ['the calling session', (): TokenPair => first],
      ['the other session', (): TokenPair => second],
    ])('should refuse the refresh token of %s issued before the change', async (_label, pair) => {
      expect((await postRefresh(app, pair().refreshToken)).status).toBe(401);
    });

    it('should accept the newly returned refresh token', async () => {
      const response = await postRefresh(app, returned.refreshToken);

      expect(response.status).toBe(200);
      secrets.push((response.body as TokenPair).refreshToken);
    });

    it('should keep access tokens issued before the change valid until they expire', async () => {
      expect((await me(first.accessToken)).status).toBe(200);
      expect((await me(second.accessToken)).status).toBe(200);
    });
  });

  it('FR-010: should succeed with Kafka down and add no outbound dead letter', async () => {
    const countDeadLetters = async (): Promise<number> => {
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*) AS "count" FROM "outbound_dead_letters"',
      );
      return Number(rows[0].count);
    };
    const { tokens } = await registerAndLogin(app, 'no-event@example.com');
    secrets.push(tokens.accessToken, tokens.refreshToken);
    const before = await countDeadLetters();

    await change(tokens.accessToken);

    expect(await countDeadLetters()).toBe(before);
  });

  it('FR-009: should log each change once with the user id and never a secret', () => {
    const text = logger.text();

    expect(logger.lines.filter((line) => line.includes('password changed:'))).toHaveLength(4);
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
  });
});
