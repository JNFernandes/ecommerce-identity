import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
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
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';
const GENERIC_401 = '{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}';
const FORBIDDEN = { statusCode: 403, message: 'forbidden', error: 'Forbidden' };

describe('PATCH /users/{id}/status: access and validation (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let customer: LoggedInCustomer;

  /** Builds the request without an `Authorization` header. */
  function patch(id: string): request.Test {
    return request(app.getHttpServer()).patch(`/users/${id}/status`);
  }

  /** Reads the stored status of a user. */
  async function statusOf(id: string): Promise<string> {
    const [row]: { status: string }[] = await dataSource.query(
      `SELECT "status" FROM "users" WHERE "id" = $1`,
      [id],
    );
    return row.status;
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
    dataSource = app.get(DataSource);
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    customer = await registerAndLogin(app, 'ana@example.com');
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it.each([
    ['no token', undefined],
    ['an invalid token', 'Bearer invalid'],
  ])('should answer %s with the generic 401', async (_label, authorization) => {
    const builder = patch(customer.userId);
    if (authorization !== undefined) {
      builder.set('Authorization', authorization);
    }

    const response = await builder.send({ status: 'DISABLED' });

    expect(response.status).toBe(401);
    expect(response.text).toBe(GENERIC_401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(await statusOf(customer.userId)).toBe('ACTIVE');
  });

  it('should answer a customer token with the generic 403 and change nothing', async () => {
    const response = await patch(customer.userId)
      .set('Authorization', `Bearer ${customer.tokens.accessToken}`)
      .send({ status: 'DISABLED' })
      .expect(403);

    expect(response.body).toEqual(FORBIDDEN);
    expect(await statusOf(customer.userId)).toBe('ACTIVE');
  });

  it('should answer 404 for an id that matches no user', async () => {
    const response = await patch(UNKNOWN_ID)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'DISABLED' })
      .expect(404);

    expect(response.body).toEqual({
      statusCode: 404,
      message: 'user not found',
      error: 'Not Found',
    });
  });

  it('should answer 400 for a malformed id', async () => {
    const response = await patch('abc')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'DISABLED' })
      .expect(400);

    expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(String(response.body.message)).toMatch(/uuid/i);
  });

  it.each([
    ['an empty body', {}],
    ['a lower-case status', { status: 'disabled' }],
    ['a numeric status', { status: 1 }],
    ['a null status', { status: null }],
    ['an unknown field', { status: 'DISABLED', x: 1 }],
  ])('should answer %s with 400 and details', async (_label, body) => {
    const response = await patch(customer.userId)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(Array.isArray(response.body.message)).toBe(true);
    expect((response.body.message as unknown[]).length).toBeGreaterThan(0);
    expect(await statusOf(customer.userId)).toBe('ACTIVE');
  });

  it('should answer malformed JSON with 400, never 5xx', async () => {
    const response = await patch(customer.userId)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/json')
      .send('{"status":');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ statusCode: 400 });
    expect(await statusOf(customer.userId)).toBe('ACTIVE');
  });
});
