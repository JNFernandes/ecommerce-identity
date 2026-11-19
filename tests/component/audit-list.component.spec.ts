import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AUDIT_FLOW_PASSWORD, changeRoles, createUser, listAudit } from './support/audit-flow';
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
const ITEM_KEYS = ['action', 'actorId', 'after', 'before', 'createdAt', 'id', 'targetId'];
const EMAILS = ['ana@example.com', 'ben@example.com', 'cy@example.com'];

describe('GET /audit (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let adminToken: string;
  let ids: string[];

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should return an empty trail with total 0 before any admin change', async () => {
    await expect(listAudit(app, adminToken)).resolves.toEqual({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    });
  });

  it('should list the changes newest first with the default page metadata', async () => {
    ids = [];
    for (const email of EMAILS) {
      ids.push(await createUser(app, adminToken, email, ['CUSTOMER']));
    }
    await changeRoles(app, adminToken, ids[0], ['CUSTOMER', 'ADMIN']);

    const page = await listAudit(app, adminToken);

    expect(page).toMatchObject({ total: 4, limit: 20, offset: 0 });
    expect(page.items.map((item) => [item.action, item.targetId])).toEqual([
      ['ROLES_CHANGED', ids[0]],
      ['USER_CREATED', ids[2]],
      ['USER_CREATED', ids[1]],
      ['USER_CREATED', ids[0]],
    ]);
    const times = page.items.map((item) => Date.parse(item.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('should return exactly the allowed keys and no secret or email', async () => {
    const page = await listAudit(app, adminToken);
    const text = JSON.stringify(page);

    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    }
    expect(page.items[0]).toMatchObject({
      before: { roles: ['CUSTOMER'] },
      after: { roles: ['CUSTOMER', 'ADMIN'] },
    });
    for (const secret of [AUDIT_FLOW_PASSWORD, ADMIN_PASSWORD, adminToken, '$argon2', ...EMAILS]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(ADMIN_EMAIL);
    expect(text).not.toMatch(/password|hash|token/i);
  });

  it('should return every record exactly once when paging', async () => {
    const all = (await listAudit(app, adminToken)).items.map((item) => item.id);
    const seen: string[] = [];
    for (let offset = 0; offset < all.length; offset += 1) {
      const page = await listAudit(app, adminToken, { limit: 1, offset });
      expect(page).toMatchObject({ total: all.length, limit: 1, offset });
      seen.push(...page.items.map((item) => item.id));
    }
    expect(seen).toEqual(all);
  });

  it('should return no items but the real total for an offset past the end', async () => {
    await expect(listAudit(app, adminToken, { offset: 50 })).resolves.toEqual({
      items: [],
      total: 4,
      limit: 20,
      offset: 50,
    });
  });
});
