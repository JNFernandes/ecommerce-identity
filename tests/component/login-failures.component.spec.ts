import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapturingLogger } from './support/capturing-logger';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';

jest.setTimeout(180_000);

const PASSWORD = 'correct-horse-battery';
const GENERIC_401 = { statusCode: 401, message: 'invalid credentials', error: 'Unauthorized' };
const AUTHORIZATION = 'Bearer do-not-log-this-header-value';

describe('POST /auth/login failures (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let passwordHash: string;

  const login = (body: unknown): request.Test =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set('Authorization', AUTHORIZATION)
      .send(body as object);

  /** Registers a customer and returns its id. */
  async function register(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, name: 'Ana', password: PASSWORD });
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  }

  /** Number of stored refresh tokens. */
  async function tokenCount(): Promise<number> {
    const [row]: { count: string }[] = await dataSource.query(
      'SELECT count(*) AS "count" FROM "refresh_tokens"',
    );
    return Number(row.count);
  }

  /** Stored `lastLoginAt` of every user. */
  async function lastLogins(): Promise<(Date | null)[]> {
    const rows: { lastLoginAt: Date | null }[] = await dataSource.query(
      'SELECT "lastLoginAt" FROM "users"',
    );
    return rows.map((row) => row.lastLoginAt);
  }

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    // Keep the login throttle out of the way: this file sends many requests from one IP.
    process.env.RATE_LIMIT_LOGIN_LIMIT = '1000';
    app = await createTestApp(logger);
    dataSource = app.get(DataSource);

    await register('ana@example.com');
    const disabledId = await register('disabled@example.com');
    await dataSource.query(`UPDATE "users" SET "status" = 'DISABLED' WHERE "id" = $1`, [
      disabledId,
    ]);
    const [row]: { passwordHash: string }[] = await dataSource.query(
      'SELECT "passwordHash" FROM "users" LIMIT 1',
    );
    passwordHash = row.passwordHash;
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  describe('401', () => {
    let responses: request.Response[];

    beforeAll(async () => {
      responses = [
        await login({ email: 'nobody@example.com', password: PASSWORD }),
        await login({ email: 'ana@example.com', password: 'wrong-password-123' }),
        await login({ email: 'ana@example.com', password: `${PASSWORD} ` }),
        await login({ email: 'disabled@example.com', password: PASSWORD }),
      ];
    });

    it('should return a byte-identical generic 401 for every credential failure', () => {
      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(response.body).toEqual(GENERIC_401);
        expect(response.text).toBe(responses[0].text);
      }
    });

    it('should store no refresh token and leave lastLoginAt unchanged', async () => {
      expect(await tokenCount()).toBe(0);
      expect(await lastLogins()).toEqual([null, null]);
    });
  });

  describe('400', () => {
    it.each([
      ['a missing password', { email: 'ana@example.com' }],
      ['a missing email', { password: PASSWORD }],
      ['a non-string password', { email: 'ana@example.com', password: 12345678901 }],
      ['an empty password', { email: 'ana@example.com', password: '' }],
      ['an unknown property', { email: 'ana@example.com', password: PASSWORD, remember: true }],
      ['a badly formed email', { email: 'not-an-email', password: PASSWORD }],
    ])('should reject %s', async (_case, body) => {
      const response = await login(body);

      expect(response.status).toBe(400);
      expect(await tokenCount()).toBe(0);
    });

    it('should reject malformed JSON', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"email": "ana@example.com", ');

      expect(response.status).toBe(400);
    });
  });

  it('should never log a password, hash, token or Authorization header', async () => {
    const success = await login({ email: 'ana@example.com', password: PASSWORD });
    expect(success.status).toBe(200);
    const { accessToken, refreshToken } = success.body as {
      accessToken: string;
      refreshToken: string;
    };

    const logs = logger.text();

    expect(logs).toContain('login failed');
    expect(logs).toContain('login succeeded');
    for (const secret of [
      PASSWORD,
      'wrong-password-123',
      passwordHash,
      accessToken,
      refreshToken,
      AUTHORIZATION,
      'do-not-log-this-header-value',
    ]) {
      expect(logs).not.toContain(secret);
    }
  });
});
