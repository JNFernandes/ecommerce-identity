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
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';

describe('GET /users/{id} (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let adminToken: string;
  let customer: LoggedInCustomer;

  /** Calls the endpoint as the admin. */
  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${adminToken}`);
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    customer = await registerAndLogin(app, 'ana@example.com');
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should return the user with exactly the same body as its list item', async () => {
    const one = await get(`/users/${customer.userId}`).expect(200);
    const list = await get('/users').query({ email: 'ana@' }).expect(200);

    expect(one.body).toEqual(list.body.items[0]);
    expect(one.body).toMatchObject({
      id: customer.userId,
      customerId: customer.customerId,
      email: 'ana@example.com',
      roles: ['CUSTOMER'],
      status: 'ACTIVE',
    });
    expect(one.text).not.toMatch(/password|\$argon2/i);
  });

  it('should return 404 for an id that matches no user', async () => {
    const response = await get(`/users/${UNKNOWN_ID}`).expect(404);

    expect(response.body).toEqual({
      statusCode: 404,
      message: 'user not found',
      error: 'Not Found',
    });
  });

  it('should return 400 with validation details for a malformed id', async () => {
    const response = await get('/users/abc').expect(400);

    expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(String(response.body.message)).toMatch(/uuid/i);
  });

  it('should keep GET /users/me as the caller own account in the US-05 shape', async () => {
    const response = await get('/users/me').expect(200);

    expect(response.body).toMatchObject({ email: ADMIN_EMAIL, roles: ['ADMIN'] });
    expect(response.body).not.toHaveProperty('lastLoginAt');
    expect(response.body).not.toHaveProperty('customerId');
  });
});
