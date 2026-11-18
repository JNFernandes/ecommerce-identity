import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { decodeJwt } from 'jose';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TopicObserver } from './support/kafka-testing';
import {
  createTestApp,
  startPostgres,
  useAdminSeed,
  useUnreachableKafka,
} from './support/test-app';
import { loginAs, registerAndLogin } from './support/token-flow';

jest.setTimeout(240_000);

const TOPIC = 'identity.user-registered';
const ADMIN_EMAIL = 'admin@example.com';
const FIRST_PASSWORD = 'change-me-now-123';
const SECOND_PASSWORD = 'another-password-456';

interface AdminRow {
  id: string;
  customerId: string | null;
  email: string;
  name: string;
  passwordHash: string;
  roles: string;
  status: string;
}

/** Every user holding `ADMIN`. */
function adminRows(app: INestApplication): Promise<AdminRow[]> {
  return app.get(DataSource).query(
    `SELECT "id", "customerId", "email", "name", "passwordHash", "roles"::text AS "roles", "status"
       FROM "users" WHERE 'ADMIN' = ANY("roles")`,
  );
}

describe('admin seed (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let kafka: StartedKafkaContainer;
  let observer: TopicObserver;
  let app: INestApplication;
  let firstRow: AdminRow;

  beforeAll(async () => {
    [postgres, kafka] = await Promise.all([
      startPostgres(),
      new KafkaContainer('confluentinc/cp-kafka:7.6.1').start(),
    ]);
    const broker = `${kafka.getHost()}:${kafka.getMappedPort(9093)}`;
    process.env.KAFKA_BROKERS = broker;
    observer = await TopicObserver.start(broker, TOPIC);

    useAdminSeed({ email: ' Admin@Example.com ', password: FIRST_PASSWORD });
    app = await createTestApp();
    [firstRow] = await adminRows(app);
  });

  afterAll(async () => {
    await observer?.stop();
    await app?.close();
    await Promise.all([kafka?.stop(), postgres?.stop()]);
    process.env = savedEnv;
  });

  it('should create exactly one ACTIVE admin without a customerId on the first start', async () => {
    expect(await adminRows(app)).toHaveLength(1);
    expect(firstRow).toMatchObject({
      customerId: null,
      email: ADMIN_EMAIL,
      name: 'Administrator',
      roles: '{ADMIN}',
      status: 'ACTIVE',
    });
    expect(firstRow.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('should let the admin log in with an ADMIN token without customerId', async () => {
    const tokens = await loginAs(app, ADMIN_EMAIL, FIRST_PASSWORD);
    const claims = decodeJwt(tokens.accessToken);

    expect(claims.sub).toBe(firstRow.id);
    expect(claims.roles).toEqual(['ADMIN']);
    expect(claims).not.toHaveProperty('customerId');
  });

  it('should publish no identity.user-registered event for the admin', async () => {
    const customer = await registerAndLogin(app, 'ana@example.com');
    await observer.waitForMessages(1);

    expect(observer.messages).toHaveLength(1);
    expect(observer.messages[0].key).toBe(customer.userId);
    expect(observer.messages.map((message) => message.value.aggregateId)).not.toContain(
      firstRow.id,
    );
  });

  it('should change nothing on a restart with different seed values', async () => {
    await app.close();
    useAdminSeed({ email: 'other-admin@example.com', password: SECOND_PASSWORD, name: 'Other' });
    app = await createTestApp();

    expect(await adminRows(app)).toEqual([firstRow]);
    await expect(loginAs(app, ADMIN_EMAIL, FIRST_PASSWORD)).resolves.toBeDefined();
    const withNewPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password: SECOND_PASSWORD });
    expect(withNewPassword.status).toBe(401);
  });

  it('should seed with ADMIN_NAME while Kafka is unreachable', async () => {
    await app.close();
    const admin = await postgresAdmin(postgres);
    await admin.query('CREATE DATABASE "seed_named"');
    await admin.destroy();
    process.env.DATABASE_NAME = 'seed_named';
    await useUnreachableKafka();
    useAdminSeed({ email: 'root@example.com', password: FIRST_PASSWORD, name: ' Root Admin ' });

    app = await createTestApp();

    const rows = await adminRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'root@example.com', name: 'Root Admin' });
    await expect(loginAs(app, 'root@example.com', FIRST_PASSWORD)).resolves.toBeDefined();
  });
});

/** A connection to the container's default database, for creating another one. */
async function postgresAdmin(container: StartedPostgreSqlContainer): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'postgres',
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
  });
  return dataSource.initialize();
}
