import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import { insertAdminAndLogin, registerAndLogin } from './support/token-flow';

jest.setTimeout(180_000);

const GENERIC_401 = '{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}';

interface UserRow {
  id: string;
  customerId: string | null;
  email: string;
  name: string;
  roles: string[];
  status: string;
  createdAt: Date;
}

/** Runs against real PostgreSQL; Kafka is unreachable (publishing is not under test here). */
describe('GET /users/me (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    app = await createTestApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  const me = (accessToken: string): request.Test =>
    request(app.getHttpServer()).get('/users/me').set('Authorization', `Bearer ${accessToken}`);

  async function storedRow(id: string): Promise<UserRow> {
    const rows: UserRow[] = await dataSource.query(
      'SELECT "id", "customerId", "email", "name", "roles", "status", "createdAt" FROM "users" WHERE "id" = $1',
      [id],
    );
    return rows[0];
  }

  function expectGeneric401(response: request.Response): void {
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.text).toBe(GENERIC_401);
  }

  it('should return exactly the stored account of a customer', async () => {
    const { userId, customerId, tokens } = await registerAndLogin(app, 'me@example.com');

    const response = await me(tokens.accessToken);

    expect(response.status).toBe(200);
    const row = await storedRow(userId);
    expect(response.body).toEqual({
      id: userId,
      customerId,
      email: row.email,
      name: row.name,
      roles: ['CUSTOMER'],
      status: 'ACTIVE',
      createdAt: new Date(row.createdAt).toISOString(),
    });
    expect(row.customerId).toBe(customerId);
    expect(response.text).not.toMatch(/password|hash|argon2|token|updatedAt|lastLoginAt/i);
  });

  it('should return an admin without customerId', async () => {
    const { userId, tokens } = await insertAdminAndLogin(app, 'admin@example.com');

    const response = await me(tokens.accessToken);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: userId,
      email: 'admin@example.com',
      name: 'Admin',
      roles: ['ADMIN'],
      status: 'ACTIVE',
      createdAt: expect.any(String) as unknown,
    });
    expect('customerId' in (response.body as object)).toBe(false);
  });

  it('should refuse a user disabled after login with the generic 401', async () => {
    const { userId, tokens } = await registerAndLogin(app, 'disabled@example.com');
    await dataSource.query(`UPDATE "users" SET "status" = 'DISABLED' WHERE "id" = $1`, [userId]);

    expectGeneric401(await me(tokens.accessToken));
  });

  it('should refuse a user deleted after login with the generic 401', async () => {
    const { userId, tokens } = await registerAndLogin(app, 'deleted@example.com');
    await dataSource.query('DELETE FROM "refresh_tokens" WHERE "userId" = $1', [userId]);
    await dataSource.query('DELETE FROM "users" WHERE "id" = $1', [userId]);

    expectGeneric401(await me(tokens.accessToken));
  });

  it('should refuse a request without a token with the same 401', async () => {
    expectGeneric401(await request(app.getHttpServer()).get('/users/me'));
  });
});
