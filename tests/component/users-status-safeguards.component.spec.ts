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
import { insertAdminAndLogin, LoggedInAdmin, loginAs } from './support/token-flow';

jest.setTimeout(240_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const GENERIC_401 = '{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}';

describe('PATCH /users/{id}/status: admin safeguards (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let adminA: { userId: string; token: string };
  let adminB: LoggedInAdmin;

  /** Sends a status change with the given access token. */
  function patchStatus(token: string, id: string, status: string): request.Test {
    return request(app.getHttpServer())
      .patch(`/users/${id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status });
  }

  /** Reads the stored status of a user. */
  async function statusOf(id: string): Promise<string> {
    const [row]: { status: string }[] = await dataSource.query(
      `SELECT "status" FROM "users" WHERE "id" = $1`,
      [id],
    );
    return row.status;
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
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should refuse an admin disabling their own account with 409 and change nothing', async () => {
    const response = await patchStatus(adminA.token, adminA.userId, 'DISABLED');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      message: 'an admin cannot disable their own account',
      error: 'Conflict',
    });
    expect(await statusOf(adminA.userId)).toBe('ACTIVE');
  });

  it('should let an admin enable their own active account as a no-op', async () => {
    const response = await patchStatus(adminA.token, adminA.userId, 'ACTIVE').expect(200);

    expect(response.body).toMatchObject({ id: adminA.userId, status: 'ACTIVE' });
  });

  it('should let one admin disable another, whose still-valid token is then refused', async () => {
    await patchStatus(adminA.token, adminB.userId, 'DISABLED').expect(200);
    expect(await statusOf(adminB.userId)).toBe('DISABLED');

    for (const [id, status] of [
      [adminA.userId, 'DISABLED'],
      [adminB.userId, 'ACTIVE'],
    ]) {
      const response = await patchStatus(adminB.tokens.accessToken, id, status);

      expect(response.status).toBe(401);
      expect(response.text).toBe(GENERIC_401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
    expect(await statusOf(adminA.userId)).toBe('ACTIVE');
    expect(await statusOf(adminB.userId)).toBe('DISABLED');
  });

  it('should let an admin re-enable another admin', async () => {
    await patchStatus(adminA.token, adminB.userId, 'ACTIVE').expect(200);

    expect(await statusOf(adminB.userId)).toBe('ACTIVE');
    expect(await activeAdmins()).toBe(2);
  });

  it('should leave exactly one ACTIVE admin when two admins disable each other at once', async () => {
    const responses = await Promise.all([
      patchStatus(adminA.token, adminB.userId, 'DISABLED'),
      patchStatus(adminB.tokens.accessToken, adminA.userId, 'DISABLED'),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(responses.find((response) => response.status === 401)?.text).toBe(GENERIC_401);
    expect(await activeAdmins()).toBe(1);
  });
});
