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
import { loginAs } from './support/token-flow';

jest.setTimeout(240_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';

interface DeadLetterRow {
  eventId: string;
  key: string;
  status: string;
  payload: { eventId: string };
}

describe('POST /users with Kafka unreachable (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  /** Creates a user as the seeded admin. */
  function create(email: string, roles: string[]): request.Test {
    return request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, name: 'Dee', password: 'dee-initial-pass-123', roles });
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

  it('should create a customer with 201 and dead-letter its event with the same eventId', async () => {
    const response = await create('dee-customer@example.com', ['CUSTOMER']).expect(201);
    const id = (response.body as { id: string }).id;

    const rows: DeadLetterRow[] = await dataSource.query(
      `SELECT "eventId", "key", "status"::text AS "status", "payload"
         FROM "outbound_dead_letters" WHERE "key" = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING_RETRY');
    expect(rows[0].payload.eventId).toBe(rows[0].eventId);
    const users: unknown[] = await dataSource.query('SELECT 1 FROM "users" WHERE "id" = $1', [id]);
    expect(users).toHaveLength(1);
  });

  it('should create an admin with 201 and no dead-letter row', async () => {
    const response = await create('dee-admin@example.com', ['ADMIN']).expect(201);
    const id = (response.body as { id: string }).id;

    const rows: unknown[] = await dataSource.query(
      'SELECT 1 FROM "outbound_dead_letters" WHERE "key" = $1',
      [id],
    );
    expect(rows).toEqual([]);
  });

  it('should have audited both creations', async () => {
    const rows: { action: string }[] = await dataSource.query(
      `SELECT "action" FROM "audit_records" ORDER BY "occurredAt"`,
    );

    expect(rows).toEqual([{ action: 'USER_CREATED' }, { action: 'USER_CREATED' }]);
  });
});
