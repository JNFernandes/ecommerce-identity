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
import { loginAs, registerAndLogin } from './support/token-flow';

jest.setTimeout(240_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const GENERIC_401 = { statusCode: 401, message: 'unauthorized', error: 'Unauthorized' };

interface OpenApiOperation {
  security?: Record<string, string[]>[];
  responses: Record<string, unknown>;
}

/** A valid body with a unique email. */
function body(email: string): Record<string, unknown> {
  return { email, name: 'Ivy', password: 'ivy-initial-pass-123', roles: ['CUSTOMER'] };
}

describe('POST /users is for active admins only (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  /** Number of users and audit rows. */
  async function writes(): Promise<number[]> {
    const [row] = (await dataSource.query(
      `SELECT (SELECT count(*) FROM "users")::int AS "u", (SELECT count(*) FROM "audit_records")::int AS "a"`,
    )) as { u: number; a: number }[];
    return [row.u, row.a];
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp(undefined, [], { swagger: true });
    dataSource = app.get(DataSource);
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should return 401 without a token', async () => {
    const before = await writes();

    await request(app.getHttpServer()).post('/users').send(body('a1@example.com')).expect(401);

    expect(await writes()).toEqual(before);
  });

  it('should return 401 with a malformed token', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', 'Bearer not-a-jwt')
      .send(body('a2@example.com'))
      .expect(401);
  });

  it('should return 403 for a customer and write nothing', async () => {
    const customer = await registerAndLogin(app, 'cust@example.com');
    const before = await writes();

    await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${customer.tokens.accessToken}`)
      .send({ ...body('a3@example.com'), roles: ['ADMIN'] })
      .expect(403);

    expect(await writes()).toEqual(before);
  });

  it('should return the generic 401 to an admin disabled after their token was issued', async () => {
    const created = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...body('second-admin@example.com'), roles: ['ADMIN'] })
      .expect(201);
    const secondToken = (await loginAs(app, 'second-admin@example.com', 'ivy-initial-pass-123'))
      .accessToken;
    await request(app.getHttpServer())
      .patch(`/users/${(created.body as { id: string }).id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'DISABLED' })
      .expect(200);
    const before = await writes();

    const response = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${secondToken}`)
      .send(body('a4@example.com'))
      .expect(401);

    expect(response.body).toEqual(GENERIC_401);
    expect(await writes()).toEqual(before);
  });

  it('should document POST /users as bearer-protected with 201, 400, 401, 403 and 409', async () => {
    const doc = (await request(app.getHttpServer()).get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, OpenApiOperation>>;
    };

    const operation = doc.paths['/users'].post;
    expect(operation.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining(['201', '400', '401', '403', '409']),
    );
  });
});
