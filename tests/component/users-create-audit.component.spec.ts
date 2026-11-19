import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapturingLogger } from './support/capturing-logger';
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
const NEW_USERS = [
  { email: 'jo@example.com', name: 'Jo Admin', password: 'jo-secret-pass-123', roles: ['ADMIN'] },
  {
    email: 'kim@example.com',
    name: 'Kim Customer',
    password: 'kim-secret-pass-123',
    roles: ['CUSTOMER'],
  },
];

interface AuditRow {
  actorId: string;
  action: string;
  targetId: string;
  before: unknown;
  after: unknown;
  occurredAt: Date;
}

describe('POST /users is audited without secrets (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let adminId: string;
  let responses: request.Response[];
  let startedAt: number;
  let finishedAt: number;

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp(logger);
    dataSource = app.get(DataSource);
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    const [admin] = (await dataSource.query(`SELECT "id" FROM "users" WHERE "email" = $1`, [
      ADMIN_EMAIL,
    ])) as { id: string }[];
    adminId = admin.id;

    startedAt = Date.now();
    responses = [];
    for (const user of NEW_USERS) {
      responses.push(
        await request(app.getHttpServer())
          .post('/users')
          .set('Authorization', `Bearer ${adminToken}`)
          .send(user)
          .expect(201),
      );
    }
    finishedAt = Date.now();
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  /** All audit rows, oldest first. */
  function auditRows(): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT "actorId", "action", "targetId", "before", "after", "occurredAt"
         FROM "audit_records" ORDER BY "occurredAt"`,
    );
  }

  it('should write exactly one USER_CREATED record per creation, with the roles only', async () => {
    const rows = await auditRows();

    expect(rows).toHaveLength(2);
    rows.forEach((row, index) => {
      const target = responses[index].body as { id: string };
      expect(row).toMatchObject({
        actorId: adminId,
        action: 'USER_CREATED',
        targetId: target.id,
        before: null,
        after: { roles: NEW_USERS[index].roles },
      });
      const at = new Date(row.occurredAt).getTime();
      expect(at).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(at).toBeLessThanOrEqual(finishedAt + 1000);
    });
  });

  it('should refuse to update or delete audit records', async () => {
    await expect(dataSource.query(`UPDATE "audit_records" SET "action" = 'X'`)).rejects.toThrow(
      'audit records are append-only',
    );
    await expect(dataSource.query(`DELETE FROM "audit_records"`)).rejects.toThrow(
      'audit records are append-only',
    );
    expect(await auditRows()).toHaveLength(2);
  });

  it('should log one creation line per user with ids and role only', () => {
    const lines = logger.lines.filter((line) => line.includes('user created:'));

    expect(lines).toHaveLength(2);
    responses.forEach((response, index) => {
      expect(lines[index]).toContain(
        `user created: actorId=${adminId} targetId=${(response.body as { id: string }).id} ` +
          `roles=${NEW_USERS[index].roles[0]}`,
      );
    });
  });

  it('should never put a password, hash, email, name or token in logs, audit rows or responses', async () => {
    const logs = logger.text();
    const audits = JSON.stringify(await auditRows());
    const bodies = responses.map((response) => response.text).join('\n');

    for (const user of NEW_USERS) {
      expect(logs).not.toContain(user.password);
      expect(audits).not.toContain(user.password);
      expect(bodies).not.toContain(user.password);
      expect(logs).not.toContain(user.email);
      expect(audits).not.toContain(user.email);
      expect(logs).not.toContain(user.name);
      expect(audits).not.toContain(user.name);
    }
    for (const text of [logs, audits, bodies]) {
      expect(text).not.toContain('$argon2id$');
      expect(text).not.toContain(adminToken);
      expect(text).not.toMatch(/passwordHash/);
    }
  });
});
