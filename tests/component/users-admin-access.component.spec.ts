import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestApp,
  startPostgres,
  useAdminSeed,
  useUnreachableKafka,
} from './support/test-app';
import { loginAs, LoggedInCustomer, registerAndLogin } from './support/token-flow';

jest.setTimeout(240_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const UNAUTHORIZED = { statusCode: 401, message: 'unauthorized', error: 'Unauthorized' };
const FORBIDDEN = { statusCode: 403, message: 'forbidden', error: 'Forbidden' };

describe('admin-only user endpoints (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let adminToken: string;
  let customer: LoggedInCustomer;
  let paths: string[];

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    customer = await registerAndLogin(app, 'ana@example.com');
    paths = ['/users', `/users/${customer.userId}`];
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should answer the generic 401 without a token', async () => {
    for (const path of paths) {
      const response = await request(app.getHttpServer()).get(path).expect(401);

      expect(response.body).toEqual(UNAUTHORIZED);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('should answer the generic 401 for an invalid token', async () => {
    for (const path of paths) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer invalid')
        .expect(401);

      expect(response.body).toEqual(UNAUTHORIZED);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('should answer 403 with no user data for a customer token', async () => {
    for (const path of paths) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${customer.tokens.accessToken}`)
        .expect(403);

      expect(response.body).toEqual(FORBIDDEN);
      expect(response.text).not.toContain('ana@example.com');
    }
  });

  it('should answer 200 for an admin token', async () => {
    for (const path of paths) {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    }
  });

  it.each([
    ['limit below 1', { limit: '0' }],
    ['limit above 100', { limit: '101' }],
    ['a negative offset', { offset: '-1' }],
    ['a non-integer limit', { limit: 'abc' }],
    ['a decimal offset', { offset: '1.5' }],
    ['an unknown role', { role: 'ROOT' }],
    ['an unknown status', { status: 'GONE' }],
    ['an unknown parameter', { foo: '1' }],
    ['an email filter over 254 characters', { email: 'a'.repeat(255) }],
  ])('should answer 400 with validation details for %s', async (_case, query) => {
    const response = await request(app.getHttpServer())
      .get('/users')
      .query(query)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);

    expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(Array.isArray(response.body.message)).toBe(true);
    expect((response.body.message as unknown[]).length).toBeGreaterThan(0);
    for (const line of response.body.message as unknown[]) {
      expect(typeof line).toBe('string');
    }
  });
});
