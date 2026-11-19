import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestApp,
  startPostgres,
  useAdminSeed,
  useUnreachableKafka,
} from './support/test-app';
import {
  FLOW_PASSWORD,
  loginAs,
  LoggedInCustomer,
  postRefresh,
  registerAndLogin,
  TokenPair,
} from './support/token-flow';

jest.setTimeout(240_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const CUSTOMER_EMAIL = 'ana@example.com';

describe('PATCH /users/{id}/status: enable (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let adminToken: string;
  let customer: LoggedInCustomer;
  let enabled: request.Response;

  /** Sends the status change as the admin. */
  function patchStatus(id: string, status: string): request.Test {
    return request(app.getHttpServer())
      .patch(`/users/${id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status });
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    customer = await registerAndLogin(app, CUSTOMER_EMAIL);
    await patchStatus(customer.userId, 'DISABLED').expect(200);

    enabled = await patchStatus(customer.userId, 'ACTIVE');
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should answer 200 with status ACTIVE', () => {
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({
      id: customer.userId,
      customerId: customer.customerId,
      email: CUSTOMER_EMAIL,
      status: 'ACTIVE',
    });
  });

  it('should keep refusing the refresh token revoked by the disable with the generic 401', async () => {
    const unknown = await postRefresh(app, 'never-issued-token-value');
    const response = await postRefresh(app, customer.tokens.refreshToken);

    expect(response.status).toBe(401);
    expect(response.text).toBe(unknown.text);
  });

  it('should let the user log in again and use the new refresh token', async () => {
    const tokens: TokenPair = await loginAs(app, CUSTOMER_EMAIL, FLOW_PASSWORD);

    const refreshed = await postRefresh(app, tokens.refreshToken);

    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ tokenType: 'Bearer' });
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
  });
});
