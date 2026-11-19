import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { decodeJwt } from 'jose';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TopicObserver } from './support/kafka-testing';
import { createTestApp, startPostgres, useAdminSeed } from './support/test-app';
import { loginAs } from './support/token-flow';

jest.setTimeout(240_000);

const TOPIC = 'identity.user-registered';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const NEW_PASSWORD = 'bea-initial-pass-123';

describe('POST /users creates an administrator (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let kafka: StartedKafkaContainer;
  let observer: TopicObserver;
  let app: INestApplication;
  let created: request.Response;

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
        email: '  Bea@Example.COM ',
        name: '  Bea  ',
        password: NEW_PASSWORD,
        roles: ['ADMIN'],
      });
  });

  afterAll(async () => {
    await observer?.stop();
    await app?.close();
    await Promise.all([kafka?.stop(), postgres?.stop()]);
    process.env = savedEnv;
  });

  it('should return 201 with the new admin in the admin read shape and nothing secret', () => {
    expect(created.status).toBe(201);
    const body = created.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['createdAt', 'email', 'id', 'lastLoginAt', 'name', 'roles', 'status'].sort(),
    );
    expect(body).toMatchObject({
      email: 'bea@example.com',
      name: 'Bea',
      roles: ['ADMIN'],
      status: 'ACTIVE',
      lastLoginAt: null,
    });
    expect(body.id).toEqual(expect.any(String));
    expect(created.text).not.toContain(NEW_PASSWORD);
    expect(created.text).not.toContain('$argon2id$');
  });

  it('should let the new admin log in at once, as an admin without customerId', async () => {
    const tokens = await loginAs(app, 'bea@example.com', NEW_PASSWORD);

    const claims = decodeJwt(tokens.accessToken);
    expect(claims.sub).toBe((created.body as { id: string }).id);
    expect(claims.roles).toEqual(['ADMIN']);
    expect(claims.customerId).toBeUndefined();
    await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
  });

  it('should publish no identity.user-registered event for an admin', async () => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(observer.messages).toEqual([]);
  });
});
