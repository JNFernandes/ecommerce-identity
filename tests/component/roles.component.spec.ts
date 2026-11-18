import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AdminProbeController } from './support/admin-probe.controller';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import {
  insertAdminAndLogin,
  LoggedInAdmin,
  LoggedInCustomer,
  registerAndLogin,
} from './support/token-flow';

jest.setTimeout(180_000);

const GENERIC_401 = '{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}';
const GENERIC_403 = { statusCode: 403, message: 'forbidden', error: 'Forbidden' };

/** Role restriction through a test-only `ADMIN` route (US3). */
describe('role restriction (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let customer: LoggedInCustomer;
  let admin: LoggedInAdmin;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    app = await createTestApp(undefined, [], { extraControllers: [AdminProbeController] });
    customer = await registerAndLogin(app, 'customer@example.com');
    admin = await insertAdminAndLogin(app, 'admin@example.com');
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  const get = (path: string, authorization?: string): request.Test => {
    const test = request(app.getHttpServer()).get(path);
    return authorization === undefined ? test : test.set('Authorization', authorization);
  };

  it('should refuse a customer on an ADMIN route with the generic 403', async () => {
    const response = await get('/test/admin-probe', `Bearer ${customer.tokens.accessToken}`);

    expect(response.status).toBe(403);
    expect(response.body).toEqual(GENERIC_403);
    expect(response.text).not.toContain(customer.tokens.accessToken);
  });

  it('should let an admin through and hand the handler its principal', async () => {
    const response = await get('/test/admin-probe', `Bearer ${admin.tokens.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: admin.userId, roles: ['ADMIN'] });
  });

  it.each([
    ['no token', undefined],
    ['an invalid token', 'Bearer not-a-jwt'],
  ])('should answer 401, not 403, for %s', async (_label, authorization) => {
    const response = await get('/test/admin-probe', authorization);

    expect(response.status).toBe(401);
    expect(response.text).toBe(GENERIC_401);
  });

  it('should let both a customer and an admin read /users/me', async () => {
    const [asCustomer, asAdmin] = await Promise.all([
      get('/users/me', `Bearer ${customer.tokens.accessToken}`),
      get('/users/me', `Bearer ${admin.tokens.accessToken}`),
    ]);

    expect(asCustomer.status).toBe(200);
    expect(asAdmin.status).toBe(200);
  });
});
