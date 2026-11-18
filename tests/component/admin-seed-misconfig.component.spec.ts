import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapturingLogger } from './support/capturing-logger';
import {
  createTestApp,
  startPostgres,
  useAdminSeed,
  useNewDatabase,
  useUnreachableKafka,
} from './support/test-app';
import { FLOW_PASSWORD, registerAndLogin } from './support/token-flow';

jest.setTimeout(240_000);

const VALID_PASSWORD = 'change-me-now-123';
const SHORT_PASSWORD = 'short-pw';

interface UserRow {
  id: string;
  customerId: string | null;
  email: string;
  name: string;
  passwordHash: string;
  roles: string;
  status: string;
  updatedAt: Date;
}

/** Every stored user. */
function userRows(app: INestApplication): Promise<UserRow[]> {
  return app.get(DataSource).query(
    `SELECT "id", "customerId", "email", "name", "passwordHash", "roles"::text AS "roles", "status", "updatedAt"
       FROM "users" ORDER BY "createdAt"`,
  );
}

/** Captured warn and error lines mentioning the seed. */
function seedProblems(logger: CapturingLogger): string[] {
  return logger.lines.filter(
    (line) => /^\[(warn|error)\]/.test(line) && /admin(istrator)? seed|ADMIN_/i.test(line),
  );
}

describe('admin seed misconfiguration (component)', () => {
  const savedEnv = { ...process.env };
  const loggers: CapturingLogger[] = [];
  const apps: INestApplication[] = [];
  let postgres: StartedPostgreSqlContainer;

  /** Starts an app with its own capturing logger; it is closed after each test. */
  async function start(): Promise<{ app: INestApplication; logger: CapturingLogger }> {
    const logger = new CapturingLogger();
    loggers.push(logger);
    const app = await createTestApp(logger);
    apps.push(app);
    return { app, logger };
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  afterAll(async () => {
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should warn and start normally when the seed variables are missing', async () => {
    await useNewDatabase(postgres, 'seed_missing');
    useAdminSeed(undefined);

    const { app, logger } = await start();

    expect(logger.lines).toContainEqual(
      expect.stringContaining(
        'No administrator exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set',
      ),
    );
    await request(app.getHttpServer()).get('/health').expect(200);
    expect(await userRows(app)).toEqual([]);
  });

  it('should log the broken rule and create nothing for a too short password', async () => {
    await useNewDatabase(postgres, 'seed_short');
    useAdminSeed({ email: 'admin@example.com', password: SHORT_PASSWORD });

    const { app, logger } = await start();

    expect(seedProblems(logger)).toEqual([
      expect.stringMatching(
        /^\[error\] Admin seed skipped: ADMIN_PASSWORD: password must be between 10 and 128 characters/,
      ),
    ]);
    await request(app.getHttpServer()).get('/health').expect(200);
    expect(await userRows(app)).toEqual([]);
  });

  it('should never promote or change an existing customer whose email is ADMIN_EMAIL', async () => {
    await useNewDatabase(postgres, 'seed_taken');
    useAdminSeed(undefined);
    const first = await start();
    await registerAndLogin(first.app, 'ana@example.com');
    const [before] = await userRows(first.app);
    await Promise.all(apps.splice(0).map((app) => app.close()));
    useAdminSeed({ email: ' ANA@Example.com ', password: VALID_PASSWORD });

    const { app, logger } = await start();

    expect(seedProblems(logger)).toEqual([
      expect.stringContaining(
        'ADMIN_EMAIL belongs to an existing non-admin user; admin seed skipped',
      ),
    ]);
    expect(await userRows(app)).toEqual([before]);
    expect(before.roles).toBe('{CUSTOMER}');
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ana@example.com', password: FLOW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('should log nothing about the seed when an admin exists and the variables are gone', async () => {
    await useNewDatabase(postgres, 'seed_removed');
    useAdminSeed({ email: 'admin@example.com', password: VALID_PASSWORD });
    await start();
    await Promise.all(apps.splice(0).map((app) => app.close()));
    useAdminSeed(undefined);

    const { logger } = await start();

    expect(seedProblems(logger)).toEqual([]);
  });

  it('should create exactly one admin when two instances start at the same time', async () => {
    await useNewDatabase(postgres, 'seed_concurrent');
    // Migrate first, so the two instances race on the seed only, not on the schema.
    useAdminSeed(undefined);
    await start();
    await Promise.all(apps.splice(0).map((app) => app.close()));
    useAdminSeed({ email: 'admin@example.com', password: VALID_PASSWORD });

    const [one, two] = await Promise.all([start(), start()]);

    const admins = (await userRows(one.app)).filter((row) => row.roles === '{ADMIN}');
    expect(admins).toHaveLength(1);
    await request(one.app.getHttpServer()).get('/health').expect(200);
    await request(two.app.getHttpServer()).get('/health').expect(200);
    for (const logger of [one.logger, two.logger]) {
      expect(seedProblems(logger).filter((line) => line.startsWith('[error]'))).toEqual([]);
    }
  });

  it('should never log the admin password, on any seed path', () => {
    const text = loggers.map((logger) => logger.text()).join('\n');

    expect(loggers.length).toBeGreaterThan(0);
    expect(text).not.toContain(VALID_PASSWORD);
    expect(text).not.toContain(SHORT_PASSWORD);
  });
});
