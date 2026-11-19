import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { decodeJwt } from 'jose';
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
  insertAdminAndLogin,
  LoggedInAdmin,
  LoggedInCustomer,
  loginAs,
  postRefresh,
  registerAndLogin,
} from './support/token-flow';

jest.setTimeout(240_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const CUSTOMER_EMAIL = 'cleo@example.com';
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';
const GENERIC_401 = '{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}';

interface UserRow {
  roles: string;
  customerId: string | null;
}

interface AuditRow {
  actorId: string;
  action: string;
  before: { roles: string[] };
  after: { roles: string[] };
}

describe('PUT /users/{id}/roles (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let adminA: { userId: string; token: string };
  let adminB: LoggedInAdmin;
  let cleo: LoggedInCustomer;
  let cleoRefresh: string;
  /** Cleo's own registration event, dead-lettered because Kafka is down. */
  let registrationDeadLetters: unknown[];

  /** Sends a role change with the given access token (or none) and body. */
  function putRoles(token: string | null, id: string, body: unknown): request.Test {
    const test = request(app.getHttpServer()).put(`/users/${id}/roles`);
    if (token !== null) {
      test.set('Authorization', `Bearer ${token}`);
    }
    return test.send(body as object);
  }

  /** Reads the stored roles and customer id of a user. */
  async function userRow(id: string): Promise<{ roles: string[]; customerId: string | null }> {
    const [row]: UserRow[] = await dataSource.query(
      `SELECT array_to_string("roles", ',') AS "roles", "customerId" FROM "users" WHERE "id" = $1`,
      [id],
    );
    return { roles: row.roles.split(','), customerId: row.customerId };
  }

  /** The `ROLES_CHANGED` audit rows of a target, oldest first. */
  function auditRows(targetId: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT "actorId", "action", "before", "after" FROM "audit_records"
        WHERE "targetId" = $1 AND "action" = 'ROLES_CHANGED' ORDER BY "occurredAt"`,
      [targetId],
    );
  }

  /** The dead-lettered events keyed by a user id. */
  function deadLetters(
    key: string,
  ): Promise<{ eventId: string; payload: { customerId: string } }[]> {
    return dataSource.query(
      `SELECT "eventId", "payload" FROM "outbound_dead_letters" WHERE "key" = $1`,
      [key],
    );
  }

  /** Counts the ACTIVE admins in the database. */
  async function activeAdmins(): Promise<number> {
    const [row]: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*) AS "count" FROM "users" WHERE "status" = 'ACTIVE' AND 'ADMIN' = ANY("roles")`,
    );
    return Number(row.count);
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    process.env.RATE_LIMIT_LOGIN_LIMIT = '100';
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
    dataSource = app.get(DataSource);
    const token = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    adminA = { userId: (me.body as { id: string }).id, token };
    adminB = await insertAdminAndLogin(app, 'second-admin@example.com');
    cleo = await registerAndLogin(app, CUSTOMER_EMAIL);
    cleoRefresh = cleo.tokens.refreshToken;
    registrationDeadLetters = await deadLetters(cleo.userId);
    expect(registrationDeadLetters).toHaveLength(1);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  describe('access', () => {
    it('should answer 401 without a token', async () => {
      await putRoles(null, cleo.userId, { roles: ['ADMIN'] }).expect(401);
    });

    it('should answer 403 to a customer token', async () => {
      await putRoles(cleo.tokens.accessToken, cleo.userId, { roles: ['ADMIN'] }).expect(403);
    });
  });

  describe('validation', () => {
    it.each([
      ['an empty list', { roles: [] }],
      ['an unknown role', { roles: ['OWNER'] }],
      ['a lowercase role', { roles: ['admin'] }],
      ['a repeated role', { roles: ['ADMIN', 'ADMIN'] }],
      ['missing roles', {}],
      ['an extra property', { roles: ['ADMIN'], customerId: UNKNOWN_ID }],
    ])('should answer 400 to %s and change nothing', async (_label, body) => {
      await putRoles(adminA.token, cleo.userId, body).expect(400);

      expect((await userRow(cleo.userId)).roles).toEqual(['CUSTOMER']);
    });

    it('should answer 400 to a malformed id', async () => {
      await putRoles(adminA.token, 'not-a-uuid', { roles: ['ADMIN'] }).expect(400);
    });

    it('should answer 404 to an unknown id', async () => {
      const response = await putRoles(adminA.token, UNKNOWN_ID, { roles: ['ADMIN'] }).expect(404);

      expect(response.body).toMatchObject({ message: 'user not found' });
    });
  });

  it('should treat the current roles as a no-op: 200, no audit, sessions kept', async () => {
    const response = await putRoles(adminA.token, cleo.userId, { roles: ['CUSTOMER'] }).expect(200);

    expect(response.body).toMatchObject({ id: cleo.userId, roles: ['CUSTOMER'] });
    expect(await auditRows(cleo.userId)).toEqual([]);
    const refreshed = await postRefresh(app, cleoRefresh).expect(200);
    cleoRefresh = (refreshed.body as { refreshToken: string }).refreshToken;
  });

  it('should promote a customer, keep their sessions and customerId, publish nothing', async () => {
    const response = await putRoles(adminA.token, cleo.userId, {
      roles: ['CUSTOMER', 'ADMIN'],
    }).expect(200);

    expect(response.body).toMatchObject({
      id: cleo.userId,
      customerId: cleo.customerId,
      roles: ['CUSTOMER', 'ADMIN'],
    });
    const refreshed = await postRefresh(app, cleoRefresh).expect(200);
    cleoRefresh = (refreshed.body as { refreshToken: string }).refreshToken;
    expect(decodeJwt((refreshed.body as { accessToken: string }).accessToken).roles).toEqual([
      'CUSTOMER',
      'ADMIN',
    ]);
    expect(await deadLetters(cleo.userId)).toEqual(registrationDeadLetters);
  });

  it('should let the promoted user log in and call an admin-only endpoint', async () => {
    const tokens = await loginAs(app, CUSTOMER_EMAIL, FLOW_PASSWORD);

    expect(decodeJwt(tokens.accessToken)).toMatchObject({
      roles: ['CUSTOMER', 'ADMIN'],
      customerId: cleo.customerId,
    });
    await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
  });

  it('should keep the customerId when CUSTOMER is removed, revoke sessions, publish nothing', async () => {
    const response = await putRoles(adminA.token, cleo.userId, { roles: ['ADMIN'] }).expect(200);

    expect(response.body).toMatchObject({ roles: ['ADMIN'], customerId: cleo.customerId });
    expect(await userRow(cleo.userId)).toEqual({ roles: ['ADMIN'], customerId: cleo.customerId });
    await postRefresh(app, cleoRefresh).expect(401);
    const claims = decodeJwt((await loginAs(app, CUSTOMER_EMAIL, FLOW_PASSWORD)).accessToken);
    expect(claims.roles).toEqual(['ADMIN']);
    expect(claims).not.toHaveProperty('customerId');
    expect(await deadLetters(cleo.userId)).toEqual(registrationDeadLetters);
  });

  it('should reuse the same customerId on a re-grant, without event', async () => {
    const response = await putRoles(adminA.token, cleo.userId, {
      roles: ['ADMIN', 'CUSTOMER'],
    }).expect(200);

    expect(response.body).toMatchObject({ customerId: cleo.customerId });
    expect(await deadLetters(cleo.userId)).toEqual(registrationDeadLetters);
  });

  it('should create a customerId on a first CUSTOMER grant and dead-letter its event', async () => {
    const response = await putRoles(adminA.token, adminB.userId, {
      roles: ['ADMIN', 'CUSTOMER'],
    }).expect(200);

    const customerId = (response.body as { customerId: string }).customerId;
    expect(customerId).toEqual(expect.any(String));
    expect(customerId).not.toBe(adminB.userId);
    const rows = await deadLetters(adminB.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.customerId).toBe(customerId);
    // A grant revokes nothing.
    await postRefresh(app, adminB.tokens.refreshToken).expect(200);
  });

  it('should refuse an admin removing their own ADMIN role with 409', async () => {
    const response = await putRoles(adminA.token, adminA.userId, { roles: ['CUSTOMER'] });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      message: 'an admin cannot remove their own ADMIN role',
      error: 'Conflict',
    });
    expect((await userRow(adminA.userId)).roles).toEqual(['ADMIN']);
  });

  it('should let an admin add CUSTOMER to themselves', async () => {
    await putRoles(adminA.token, adminA.userId, { roles: ['ADMIN', 'CUSTOMER'] }).expect(200);
    await putRoles(adminA.token, adminA.userId, { roles: ['ADMIN'] }).expect(200);
  });

  it('should revoke every session of a demoted admin, whose old token then gets the generic 401', async () => {
    const cleoTokens = await loginAs(app, CUSTOMER_EMAIL, FLOW_PASSWORD);

    await putRoles(adminA.token, cleo.userId, { roles: ['CUSTOMER'] }).expect(200);

    await postRefresh(app, cleoTokens.refreshToken).expect(401);
    const response = await putRoles(cleoTokens.accessToken, adminA.userId, { roles: ['CUSTOMER'] });
    expect(response.status).toBe(401);
    expect(response.text).toBe(GENERIC_401);
  });

  it('should answer the generic 401 to a disabled admin', async () => {
    const extra = await insertAdminAndLogin(app, 'third-admin@example.com');
    await request(app.getHttpServer())
      .patch(`/users/${extra.userId}/status`)
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ status: 'DISABLED' })
      .expect(200);

    const response = await putRoles(extra.tokens.accessToken, cleo.userId, { roles: ['ADMIN'] });

    expect(response.status).toBe(401);
    expect(response.text).toBe(GENERIC_401);
  });

  it('should write one ROLES_CHANGED audit record per effective change, with roles only', async () => {
    const rows = await auditRows(cleo.userId);

    expect(rows.map((row) => [row.before.roles, row.after.roles])).toEqual([
      [['CUSTOMER'], ['CUSTOMER', 'ADMIN']],
      [['CUSTOMER', 'ADMIN'], ['ADMIN']],
      [['ADMIN'], ['ADMIN', 'CUSTOMER']],
      [['ADMIN', 'CUSTOMER'], ['CUSTOMER']],
    ]);
    for (const row of rows) {
      expect(row.actorId).toBe(adminA.userId);
      expect(Object.keys(row.before)).toEqual(['roles']);
      expect(Object.keys(row.after)).toEqual(['roles']);
    }
  });

  it('should leave one ACTIVE admin when the last two demote each other at once', async () => {
    expect(await activeAdmins()).toBe(2);

    const responses = await Promise.all([
      putRoles(adminA.token, adminB.userId, { roles: ['CUSTOMER'] }),
      putRoles(adminB.tokens.accessToken, adminA.userId, { roles: ['CUSTOMER'] }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(await activeAdmins()).toBe(1);
  });
});
