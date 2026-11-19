import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { decodeJwt } from 'jose';
import { DataSource } from 'typeorm';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TopicObserver } from './support/kafka-testing';
import { createTestApp, startPostgres, useAdminSeed } from './support/test-app';
import { loginAs } from './support/token-flow';

jest.setTimeout(240_000);

const TOPIC = 'identity.user-registered';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const NEW_PASSWORD = 'cara-initial-pass-123';

interface CreatedCustomer {
  id: string;
  customerId: string;
  email: string;
  name: string;
  createdAt: string;
}

describe('POST /users creates a customer with its event (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let kafka: StartedKafkaContainer;
  let observer: TopicObserver;
  let app: INestApplication;
  let created: request.Response;
  let body: CreatedCustomer;

  beforeAll(async () => {
    [postgres, kafka] = await Promise.all([
      startPostgres(),
      new KafkaContainer('confluentinc/cp-kafka:7.6.1').start(),
    ]);
    const broker = `${kafka.getHost()}:${kafka.getMappedPort(9093)}`;
    process.env.KAFKA_BROKERS = broker;
    observer = await TopicObserver.start(broker, TOPIC);
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();

    const adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    created = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'cara@example.com',
        name: 'Cara',
        password: NEW_PASSWORD,
        roles: ['CUSTOMER'],
      });
    body = created.body as CreatedCustomer;
    await observer.waitForMessages(1);
  });

  afterAll(async () => {
    await observer?.stop();
    await app?.close();
    await Promise.all([kafka?.stop(), postgres?.stop()]);
    process.env = savedEnv;
  });

  it('should return 201 with a new customerId different from the user id', () => {
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      roles: ['CUSTOMER'],
      status: 'ACTIVE',
      lastLoginAt: null,
    });
    expect(body.customerId).toEqual(expect.any(String));
    expect(body.customerId).not.toBe(body.id);
  });

  it('should publish exactly one identity.user-registered with the registration payload', async () => {
    expect(observer.messages).toHaveLength(1);
    const [message] = observer.messages;
    expect(message.key).toBe(body.id);
    expect(Object.keys(message.value).sort()).toEqual(
      ['aggregateId', 'customerId', 'email', 'eventId', 'name', 'occurredAt', 'version'].sort(),
    );
    expect(message.value).toMatchObject({
      aggregateId: body.id,
      customerId: body.customerId,
      email: 'cara@example.com',
      name: 'Cara',
      version: 1,
    });
    const rows: { customerId: string }[] = await app
      .get(DataSource)
      .query('SELECT "customerId" FROM "users" WHERE "id" = $1', [body.id]);
    expect(rows).toEqual([{ customerId: body.customerId }]);
  });

  it('should let the customer log in with a token carrying its customerId', async () => {
    const tokens = await loginAs(app, 'cara@example.com', NEW_PASSWORD);

    const claims = decodeJwt(tokens.accessToken);
    expect(claims.roles).toEqual(['CUSTOMER']);
    expect(claims.customerId).toBe(body.customerId);
  });
});
