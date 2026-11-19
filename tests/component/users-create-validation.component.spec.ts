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
const VALID = {
  email: 'eve@example.com',
  name: 'Eve',
  password: 'eve-initial-pass-123',
  roles: ['CUSTOMER'],
};

interface Counts {
  users: number;
  audits: number;
  deadLetters: number;
}

describe('POST /users rejects invalid and conflicting input (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  /** Sends a body as the seeded admin. */
  function post(body: unknown): request.Test {
    return request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body as object);
  }

  /** Current row counts of the tables a creation writes to. */
  async function counts(): Promise<Counts> {
    const [row] = (await dataSource.query(
      `SELECT (SELECT count(*) FROM "users")::int AS "users",
              (SELECT count(*) FROM "audit_records")::int AS "audits",
              (SELECT count(*) FROM "outbound_dead_letters")::int AS "deadLetters"`,
    )) as Counts[];
    return row;
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
    dataSource = app.get(DataSource);
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  describe('400', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['an invalid email', { ...VALID, email: 'not-an-email' }],
      ['a blank name', { ...VALID, name: '   ' }],
      ['a 101-character name', { ...VALID, name: 'n'.repeat(101) }],
      ['a 9-character password', { ...VALID, password: 'p'.repeat(9) }],
      ['a 129-character password', { ...VALID, password: 'p'.repeat(129) }],
      ['a password equal to the email', { ...VALID, password: VALID.email }],
      ['no email', { name: VALID.name, password: VALID.password, roles: VALID.roles }],
      ['no name', { email: VALID.email, password: VALID.password, roles: VALID.roles }],
      ['no password', { email: VALID.email, name: VALID.name, roles: VALID.roles }],
      ['no roles', { email: VALID.email, name: VALID.name, password: VALID.password }],
      ['an empty roles list', { ...VALID, roles: [] }],
      ['an unknown role', { ...VALID, roles: ['ROOT'] }],
      ['a repeated role', { ...VALID, roles: ['ADMIN', 'ADMIN'] }],
      ['both roles', { ...VALID, roles: ['CUSTOMER', 'ADMIN'] }],
      ['both roles, admin first', { ...VALID, roles: ['ADMIN', 'CUSTOMER'] }],
      ['an id', { ...VALID, id: '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b' }],
      ['a customerId', { ...VALID, customerId: '6f1c2a9e-8d43-4b0f-9a7e-2c5d1e3f4a5b' }],
      ['a status', { ...VALID, status: 'DISABLED' }],
      ['a createdAt', { ...VALID, createdAt: '2026-01-01T00:00:00.000Z' }],
    ];

    it.each(cases)('should reject %s and write nothing', async (_label, body) => {
      const before = await counts();

      await post(body).expect(400);

      expect(await counts()).toEqual(before);
    });

    it('should reject a body that is not valid JSON', async () => {
      const before = await counts();

      await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Content-Type', 'application/json')
        .send('{"email": ')
        .expect(400);

      expect(await counts()).toEqual(before);
    });
  });

  describe('409', () => {
    it('should reject an email already used, in any case and with spaces', async () => {
      await post({ ...VALID, email: 'fay@example.com' }).expect(201);
      const before = await counts();

      const response = await post({ ...VALID, email: '  FAY@Example.com ' }).expect(409);

      expect(response.body).toMatchObject({ message: 'email already registered' });
      expect(await counts()).toEqual(before);
    });

    it('should reject the email of a disabled user', async () => {
      const customer = await registerAndLogin(app, 'gil@example.com');
      await request(app.getHttpServer())
        .patch(`/users/${customer.userId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'DISABLED' })
        .expect(200);

      await post({ ...VALID, email: 'gil@example.com' }).expect(409);
    });

    it('should create only one user when two requests race for the same new email', async () => {
      const before = await counts();

      const statuses = await Promise.all([
        post({ ...VALID, email: 'hal@example.com', roles: ['ADMIN'] }),
        post({ ...VALID, email: 'HAL@example.com', roles: ['ADMIN'] }),
      ]).then((responses) => responses.map((response) => response.status).sort());

      expect(statuses).toEqual([201, 409]);
      const after = await counts();
      expect(after.users).toBe(before.users + 1);
      expect(after.audits).toBe(before.audits + 1);
    });
  });
});
