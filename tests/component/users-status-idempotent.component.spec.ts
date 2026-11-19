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
  loginAs,
  postRefresh,
  RefreshTokenRow,
  registerAndLogin,
  rowOf,
} from './support/token-flow';

jest.setTimeout(240_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const STATUS_LINE = 'user status changed';

describe('PATCH /users/{id}/status: idempotent requests (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  /** Sends the status change as the admin. */
  function patchStatus(id: string, status: string): request.Test {
    return request(app.getHttpServer())
      .patch(`/users/${id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status });
  }

  /** Reads the stored `updatedAt` of a user. */
  async function updatedAtOf(id: string): Promise<Date> {
    const [row]: { updatedAt: Date }[] = await dataSource.query(
      `SELECT "updatedAt" FROM "users" WHERE "id" = $1`,
      [id],
    );
    return row.updatedAt;
  }

  /** Captured status change lines. */
  const statusLines = (): string[] => logger.lines.filter((line) => line.includes(STATUS_LINE));

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp(logger);
    dataSource = app.get(DataSource);
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should answer a repeated disable with 200 and change nothing the second time', async () => {
    const customer = await registerAndLogin(app, 'twice@example.com');
    const linesBefore = statusLines().length;

    const first = await patchStatus(customer.userId, 'DISABLED').expect(200);
    const updatedAt = await updatedAtOf(customer.userId);
    const second = await patchStatus(customer.userId, 'DISABLED').expect(200);

    expect(first.body).toMatchObject({ status: 'DISABLED' });
    expect(second.body).toEqual(first.body);
    expect(await updatedAtOf(customer.userId)).toEqual(updatedAt);
    expect(statusLines().length - linesBefore).toBe(1);
  });

  it('should answer an enable of an active user with 200 and touch nothing', async () => {
    const customer = await registerAndLogin(app, 'active@example.com');
    const updatedAt = await updatedAtOf(customer.userId);
    const tokenBefore: RefreshTokenRow | undefined = await rowOf(
      dataSource,
      customer.tokens.refreshToken,
    );
    const linesBefore = statusLines().length;

    const response = await patchStatus(customer.userId, 'ACTIVE').expect(200);

    expect(response.body).toMatchObject({ id: customer.userId, status: 'ACTIVE' });
    expect(await updatedAtOf(customer.userId)).toEqual(updatedAt);
    expect(await rowOf(dataSource, customer.tokens.refreshToken)).toEqual(tokenBefore);
    expect(statusLines().length).toBe(linesBefore);
    await postRefresh(app, customer.tokens.refreshToken).expect(200);
  });
});
