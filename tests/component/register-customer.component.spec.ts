import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapturingLogger } from './support/capturing-logger';
import { TopicObserver } from './support/kafka-testing';
import { createTestApp, startPostgres } from './support/test-app';

jest.setTimeout(240_000);

const PASSWORD = 'correct-horse-battery';
const TOPIC = 'identity.user-registered';

interface UserRow {
  id: string;
  customerId: string;
  email: string;
  name: string;
  passwordHash: string;
  roles: string;
  status: string;
}

describe('POST /auth/register (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let postgres: StartedPostgreSqlContainer;
  let kafka: StartedKafkaContainer;
  let observer: TopicObserver;
  let app: INestApplication;
  let response: request.Response;
  let row: UserRow;

  beforeAll(async () => {
    [postgres, kafka] = await Promise.all([
      startPostgres(),
      new KafkaContainer('confluentinc/cp-kafka:7.6.1').start(),
    ]);
    const broker = `${kafka.getHost()}:${kafka.getMappedPort(9093)}`;
    process.env.KAFKA_BROKERS = broker;
    observer = await TopicObserver.start(broker, TOPIC);

    app = await createTestApp(logger);

    response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'Ana@Example.com ', name: 'Ana', password: PASSWORD });
    const rows: UserRow[] = await app
      .get(DataSource)
      .query(
        'SELECT "id", "customerId", "email", "name", "passwordHash", "roles"::text AS "roles", "status" FROM "users"',
      );
    row = rows[0];
    await observer.waitForMessages(1);
  });

  afterAll(async () => {
    await observer?.stop();
    await app?.close();
    await Promise.all([kafka?.stop(), postgres?.stop()]);
    process.env = savedEnv;
  });

  it('should return 201 with exactly the six public fields', () => {
    expect(response.status).toBe(201);
    expect(Object.keys(response.body as object).sort()).toEqual(
      ['createdAt', 'customerId', 'email', 'id', 'name', 'roles'].sort(),
    );
    expect(response.body).toMatchObject({
      email: 'ana@example.com',
      name: 'Ana',
      roles: ['CUSTOMER'],
    });
  });

  it('should store an ACTIVE customer with its own customerId and an argon2id hash', () => {
    expect(row).toBeDefined();
    expect(row.id).toBe(response.body.id);
    expect(row.customerId).toBe(response.body.customerId);
    expect(row.customerId).not.toBe(row.id);
    expect(row.email).toBe('ana@example.com');
    expect(row.status).toBe('ACTIVE');
    expect(row.roles).toBe('{CUSTOMER}');
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('should return no password, hash or token', () => {
    const body = JSON.stringify(response.body);

    for (const key of ['password', 'passwordHash', 'accessToken', 'refreshToken']) {
      expect(response.body).not.toHaveProperty(key);
    }
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain(row.passwordHash);
  });

  it('should publish exactly one identity.user-registered keyed by the user id', () => {
    expect(observer.messages).toHaveLength(1);
    const [message] = observer.messages;
    expect(message.key).toBe(response.body.id);
    expect(Object.keys(message.value).sort()).toEqual(
      ['aggregateId', 'customerId', 'email', 'eventId', 'name', 'occurredAt', 'version'].sort(),
    );
    expect(message.value).toMatchObject({
      aggregateId: response.body.id,
      customerId: response.body.customerId,
      email: 'ana@example.com',
      name: 'Ana',
      version: 1,
    });
    expect(message.value.eventId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(new Date(message.value.occurredAt as string).toISOString()).toBe(
      message.value.occurredAt,
    );
  });

  it('should write no dead letter', async () => {
    const rows: unknown[] = await app
      .get(DataSource)
      .query('SELECT 1 FROM "outbound_dead_letters"');
    expect(rows).toHaveLength(0);
  });

  it('should log neither the password nor the hash', () => {
    expect(logger.lines.length).toBeGreaterThan(0);
    expect(logger.text()).not.toContain(PASSWORD);
    expect(logger.text()).not.toContain(row.passwordHash);
  });
});
