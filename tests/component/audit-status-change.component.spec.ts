import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AuditItem, changeStatus, createUser, listAudit } from './support/audit-flow';
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

describe('status changes in GET /audit (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let adminToken: string;
  let adminId: string;
  let userId: string;

  /** The status change records of the user, newest first. */
  async function statusRecords(): Promise<AuditItem[]> {
    const page = await listAudit(app, adminToken, {
      targetId: userId,
      action: 'USER_STATUS_CHANGED',
    });
    expect(page.total).toBe(page.items.length);
    return page.items;
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    const [row] = (await app
      .get(DataSource)
      .query(`SELECT "id" FROM "users" WHERE "email" = $1`, [ADMIN_EMAIL])) as { id: string }[];
    adminId = row.id;
    userId = await createUser(app, adminToken, 'ana@example.com', ['CUSTOMER']);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should record a disable with the actor, the target and both statuses', async () => {
    await changeStatus(app, adminToken, userId, 'DISABLED');

    const records = await statusRecords();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actorId: adminId,
      action: 'USER_STATUS_CHANGED',
      targetId: userId,
      before: { status: 'ACTIVE' },
      after: { status: 'DISABLED' },
    });
  });

  it('should record the enable as a second record', async () => {
    await changeStatus(app, adminToken, userId, 'ACTIVE');

    const records = await statusRecords();

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      before: { status: 'DISABLED' },
      after: { status: 'ACTIVE' },
    });
  });

  it('should write nothing for a no-op status change', async () => {
    await changeStatus(app, adminToken, userId, 'ACTIVE');

    await expect(statusRecords()).resolves.toHaveLength(2);
  });
});
