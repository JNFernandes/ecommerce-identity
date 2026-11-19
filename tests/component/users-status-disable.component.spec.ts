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
import {
  FLOW_PASSWORD,
  loginAs,
  LoggedInCustomer,
  postRefresh,
  RefreshTokenRow,
  registerAndLogin,
  TokenPair,
} from './support/token-flow';

jest.setTimeout(240_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const CUSTOMER_EMAIL = 'ana@example.com';
const GENERIC_ME_401 = '{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}';

describe('PATCH /users/{id}/status: disable (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let customer: LoggedInCustomer;
  let secondLogin: TokenPair;
  let wrongPassword401: string;
  let disabled: request.Response;

  /** Sends the status change as the admin. */
  function patchStatus(id: string, status: string): request.Test {
    return request(app.getHttpServer())
      .patch(`/users/${id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status });
  }

  /** Every stored refresh token row of a user. */
  function tokenRows(userId: string): Promise<RefreshTokenRow[]> {
    return dataSource.query(`SELECT * FROM "refresh_tokens" WHERE "userId" = $1`, [userId]);
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
    dataSource = app.get(DataSource);
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    customer = await registerAndLogin(app, CUSTOMER_EMAIL);
    secondLogin = await loginAs(app, CUSTOMER_EMAIL, FLOW_PASSWORD);
    wrongPassword401 = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: CUSTOMER_EMAIL, password: 'wrong-password-123' })
    ).text;

    disabled = await patchStatus(customer.userId, 'DISABLED');
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should answer 200 with the GET /users/{id} body showing DISABLED', async () => {
    const one = await request(app.getHttpServer())
      .get(`/users/${customer.userId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(disabled.status).toBe(200);
    expect(disabled.body).toEqual(one.body);
    expect(disabled.body).toMatchObject({
      id: customer.userId,
      customerId: customer.customerId,
      email: CUSTOMER_EMAIL,
      status: 'DISABLED',
    });
  });

  it('should revoke every refresh token of the user, in every family', async () => {
    const rows = await tokenRows(customer.userId);

    expect(new Set(rows.map((row) => row.familyId)).size).toBe(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('should refuse a login with the correct password with the generic 401 body', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: CUSTOMER_EMAIL, password: FLOW_PASSWORD });

    expect(response.status).toBe(401);
    expect(response.text).toBe(wrongPassword401);
  });

  it.each([
    ['first', (): string => customer.tokens.refreshToken],
    ['second', (): string => secondLogin.refreshToken],
  ])('should refuse the %s session refresh token with the generic 401', async (_label, token) => {
    const unknown = await postRefresh(app, 'never-issued-token-value');
    const response = await postRefresh(app, token());

    expect(response.status).toBe(401);
    expect(response.text).toBe(unknown.text);
  });

  it("should refuse GET /users/me with the customer's still-valid access token", async () => {
    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${customer.tokens.accessToken}`);

    expect(response.status).toBe(401);
    expect(response.text).toBe(GENERIC_ME_401);
  });

  it('should disable a user who has no refresh token', async () => {
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'never-logged-in@example.com', name: 'Bob', password: FLOW_PASSWORD })
      .expect(201);
    const id = (registered.body as { id: string }).id;

    const response = await patchStatus(id, 'DISABLED').expect(200);

    expect(response.body).toMatchObject({ id, status: 'DISABLED', lastLoginAt: null });
    expect(await tokenRows(id)).toEqual([]);
  });
  it('should write one USER_STATUS_CHANGED audit record for the disable, with ids and statuses only', async () => {
    const [actor] = (await dataSource.query('SELECT "id" FROM "users" WHERE "email" = $1', [
      ADMIN_EMAIL,
    ])) as { id: string }[];

    const rows: { actorId: string; action: string; before: unknown; after: unknown }[] =
      await dataSource.query(
        `SELECT "actorId", "action", "before", "after" FROM "audit_records" WHERE "targetId" = $1`,
        [customer.userId],
      );

    expect(rows).toEqual([
      {
        actorId: actor.id,
        action: 'USER_STATUS_CHANGED',
        before: { status: 'ACTIVE' },
        after: { status: 'DISABLED' },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(CUSTOMER_EMAIL);
  });
});
