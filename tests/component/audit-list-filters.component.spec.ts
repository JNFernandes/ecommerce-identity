import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  AUDIT_FLOW_PASSWORD,
  changeRoles,
  changeStatus,
  createUser,
  listAudit,
} from './support/audit-flow';
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

describe('GET /audit filters (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let tokenA: string;
  let adminA: string;
  let adminB: string;
  let userX: string;
  let userY: string;

  /** `[action, actorId, targetId]` of each item of the filtered page, plus the total. */
  async function filtered(
    query: Record<string, string>,
  ): Promise<{ rows: string[][]; total: number }> {
    const page = await listAudit(app, tokenA, query);
    return {
      rows: page.items.map((item) => [item.action, item.actorId, item.targetId]),
      total: page.total,
    };
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
    tokenA = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    const [row] = (await app
      .get(DataSource)
      .query(`SELECT "id" FROM "users" WHERE "email" = $1`, [ADMIN_EMAIL])) as { id: string }[];
    adminA = row.id;

    adminB = await createUser(app, tokenA, 'bo@example.com', ['ADMIN']);
    const tokenB = (await loginAs(app, 'bo@example.com', AUDIT_FLOW_PASSWORD)).accessToken;
    userX = await createUser(app, tokenA, 'x@example.com', ['CUSTOMER']);
    userY = await createUser(app, tokenB, 'y@example.com', ['CUSTOMER']);
    await changeRoles(app, tokenA, userX, ['CUSTOMER', 'ADMIN']);
    await changeStatus(app, tokenB, userY, 'DISABLED');
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should filter by actorId', async () => {
    await expect(filtered({ actorId: adminB })).resolves.toEqual({
      rows: [
        ['USER_STATUS_CHANGED', adminB, userY],
        ['USER_CREATED', adminB, userY],
      ],
      total: 2,
    });
  });

  it('should filter by targetId', async () => {
    await expect(filtered({ targetId: userX })).resolves.toEqual({
      rows: [
        ['ROLES_CHANGED', adminA, userX],
        ['USER_CREATED', adminA, userX],
      ],
      total: 2,
    });
  });

  it('should filter by action', async () => {
    await expect(filtered({ action: 'USER_CREATED' })).resolves.toEqual({
      rows: [
        ['USER_CREATED', adminB, userY],
        ['USER_CREATED', adminA, userX],
        ['USER_CREATED', adminA, adminB],
      ],
      total: 3,
    });
  });

  it('should combine filters with AND and count only the matches', async () => {
    await expect(filtered({ actorId: adminA, action: 'USER_CREATED' })).resolves.toEqual({
      rows: [
        ['USER_CREATED', adminA, userX],
        ['USER_CREATED', adminA, adminB],
      ],
      total: 2,
    });
    await expect(
      filtered({ actorId: adminA, targetId: userX, action: 'ROLES_CHANGED' }),
    ).resolves.toEqual({ rows: [['ROLES_CHANGED', adminA, userX]], total: 1 });
    await expect(filtered({ actorId: adminA, targetId: userY })).resolves.toEqual({
      rows: [],
      total: 0,
    });
  });

  it('should answer 200 with no items for a well-formed unknown id', async () => {
    await expect(filtered({ actorId: randomUUID() })).resolves.toEqual({ rows: [], total: 0 });
    await expect(filtered({ targetId: randomUUID() })).resolves.toEqual({ rows: [], total: 0 });
  });
});
