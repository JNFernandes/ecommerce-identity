import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  AUDIT_FLOW_PASSWORD,
  changeRoles,
  changeStatus,
  createUser,
  getAudit,
} from './support/audit-flow';
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
const UNAUTHORIZED = { statusCode: 401, message: 'unauthorized', error: 'Unauthorized' };
const FORBIDDEN = { statusCode: 403, message: 'forbidden', error: 'Forbidden' };

describe('GET /audit access and validation (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let adminToken: string;

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

  it('should answer the generic 401 without a token', async () => {
    const response = await getAudit(app, undefined).expect(401);

    expect(response.body).toEqual(UNAUTHORIZED);
  });

  it('should answer 403 to a customer token', async () => {
    const customer = await registerAndLogin(app, 'ana@example.com');

    const response = await getAudit(app, customer.tokens.accessToken).expect(403);

    expect(response.body).toEqual(FORBIDDEN);
  });

  it('should answer the generic 401 to an admin since disabled', async () => {
    const id = await createUser(app, adminToken, 'dee@example.com', ['ADMIN']);
    const token = (await loginAs(app, 'dee@example.com', AUDIT_FLOW_PASSWORD)).accessToken;
    await changeStatus(app, adminToken, id, 'DISABLED');

    const response = await getAudit(app, token).expect(401);

    expect(response.body).toEqual(UNAUTHORIZED);
  });

  it('should answer the generic 401 to an admin since demoted', async () => {
    const id = await createUser(app, adminToken, 'del@example.com', ['ADMIN']);
    const token = (await loginAs(app, 'del@example.com', AUDIT_FLOW_PASSWORD)).accessToken;
    await changeRoles(app, adminToken, id, ['CUSTOMER']);

    const response = await getAudit(app, token).expect(401);

    expect(response.body).toEqual(UNAUTHORIZED);
  });

  it('should accept limit=100', async () => {
    await getAudit(app, adminToken, { limit: 100 }).expect(200);
  });

  it.each([
    ['limit 0', 'limit=0'],
    ['limit 101', 'limit=101'],
    ['a negative limit', 'limit=-1'],
    ['a decimal limit', 'limit=1.5'],
    ['a negative offset', 'offset=-1'],
    ['a decimal offset', 'offset=1.5'],
    ['an actorId that is not a UUID', 'actorId=abc'],
    ['a targetId that is not a UUID', 'targetId=123'],
    ['an unknown action', 'action=USER_DELETED'],
    ['an unknown parameter', 'foo=1'],
    ['a repeated action', 'action=USER_CREATED&action=ROLES_CHANGED'],
  ])('should answer 400 with validation details for %s', async (_case, query) => {
    const response = await getAudit(app, adminToken, query).expect(400);

    expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(Array.isArray(response.body.message)).toBe(true);
    expect((response.body.message as unknown[]).length).toBeGreaterThan(0);
  });
});
