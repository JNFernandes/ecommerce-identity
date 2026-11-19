import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TopicObserver } from './support/kafka-testing';
import { createTestApp, startPostgres, useAdminSeed } from './support/test-app';
import { insertAdminAndLogin, LoggedInAdmin, loginAs } from './support/token-flow';

jest.setTimeout(240_000);

const TOPIC = 'identity.user-registered';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';

describe('PUT /users/{id}/roles publishes on a first CUSTOMER grant (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let kafka: StartedKafkaContainer;
  let observer: TopicObserver;
  let app: INestApplication;
  let adminToken: string;
  let target: LoggedInAdmin;

  /** Sends a role change as the seeded admin. */
  function putRoles(id: string, roles: string[]): request.Test {
    return request(app.getHttpServer())
      .put(`/users/${id}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles });
  }

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
    adminToken = (await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
    target = await insertAdminAndLogin(app, 'bo@example.com');
  });

  afterAll(async () => {
    await observer?.stop();
    await app?.close();
    await Promise.all([kafka?.stop(), postgres?.stop()]);
    process.env = savedEnv;
  });

  it('should publish exactly one event with the registration payload, and none on a re-grant', async () => {
    const granted = await putRoles(target.userId, ['ADMIN', 'CUSTOMER']).expect(200);
    const customerId = (granted.body as { customerId: string }).customerId;
    await observer.waitForMessages(1);

    await putRoles(target.userId, ['ADMIN']).expect(200);
    await putRoles(target.userId, ['ADMIN', 'CUSTOMER']).expect(200);
    await observer.waitForMessages(1);

    expect(observer.messages).toHaveLength(1);
    const [message] = observer.messages;
    expect(message.key).toBe(target.userId);
    expect(Object.keys(message.value).sort()).toEqual(
      ['aggregateId', 'customerId', 'email', 'eventId', 'name', 'occurredAt', 'version'].sort(),
    );
    expect(message.value).toMatchObject({
      aggregateId: target.userId,
      customerId,
      email: 'bo@example.com',
      version: 1,
    });
  });
});
