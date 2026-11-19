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
import {
  FLOW_PASSWORD,
  loginAs,
  LoggedInCustomer,
  registerAndLogin,
  TokenPair,
} from './support/token-flow';

jest.setTimeout(240_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const CUSTOMER_EMAIL = 'ana@example.com';
const STATUS_LINE = 'user status changed';

describe('PATCH /users/{id}/status: logging (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: TokenPair;
  let adminId: string;
  let customer: LoggedInCustomer;
  let secondLogin: TokenPair;
  let revokedRows: number;

  /** Sends a status change with the given access token (none when `undefined`). */
  function patchStatus(token: string | undefined, id: string, body: unknown): request.Test {
    const builder = request(app.getHttpServer()).patch(`/users/${id}/status`);
    if (token !== undefined) {
      builder.set('Authorization', `Bearer ${token}`);
    }
    return builder.send(body as object);
  }

  /** Captured status change lines, in order. */
  const statusLines = (): string[] => logger.lines.filter((line) => line.includes(STATUS_LINE));

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp(logger);
    dataSource = app.get(DataSource);
    admin = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    adminId = (
      (
        await request(app.getHttpServer())
          .get('/users/me')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .expect(200)
      ).body as { id: string }
    ).id;
    customer = await registerAndLogin(app, CUSTOMER_EMAIL);
    secondLogin = await loginAs(app, CUSTOMER_EMAIL, FLOW_PASSWORD);

    // Failures first: none of them may log a status change or a secret.
    await patchStatus(admin.accessToken, customer.userId, { status: 'nope' }).expect(400);
    await patchStatus(undefined, customer.userId, { status: 'DISABLED' }).expect(401);
    await patchStatus('not-a-token', customer.userId, { status: 'DISABLED' }).expect(401);
    await patchStatus(customer.tokens.accessToken, customer.userId, {
      status: 'DISABLED',
    }).expect(403);
    await patchStatus(admin.accessToken, adminId, { status: 'DISABLED' }).expect(409);

    await patchStatus(admin.accessToken, customer.userId, { status: 'DISABLED' }).expect(200);
    const [row]: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*) AS "count" FROM "refresh_tokens" WHERE "userId" = $1 AND "revokedAt" IS NOT NULL`,
      [customer.userId],
    );
    revokedRows = Number(row.count);
    await patchStatus(admin.accessToken, customer.userId, { status: 'ACTIVE' }).expect(200);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should log exactly one line per effective change, in order, with ids and counts', () => {
    expect(revokedRows).toBe(2);
    expect(statusLines()).toHaveLength(2);
    expect(statusLines()[0]).toContain(
      `user status changed: actorId=${adminId} targetId=${customer.userId} ` +
        `from=ACTIVE to=DISABLED revokedTokens=${revokedRows}`,
    );
    expect(statusLines()[1]).toContain(
      `user status changed: actorId=${adminId} targetId=${customer.userId} ` +
        'from=DISABLED to=ACTIVE revokedTokens=0',
    );
  });

  it('should never log an email, a password, a token or the Authorization header', () => {
    const text = logger.text();

    for (const secret of [
      CUSTOMER_EMAIL,
      ADMIN_EMAIL,
      FLOW_PASSWORD,
      ADMIN_PASSWORD,
      admin.accessToken,
      admin.refreshToken,
      customer.tokens.accessToken,
      customer.tokens.refreshToken,
      secondLogin.accessToken,
      secondLogin.refreshToken,
      'not-a-token',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/authorization/i);
  });
});
