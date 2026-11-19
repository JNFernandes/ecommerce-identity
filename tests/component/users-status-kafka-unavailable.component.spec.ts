import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { LazyKafkaProducer } from '../../src/infra/kafka/lazy-kafka-producer';
import {
  createTestApp,
  startPostgres,
  useAdminSeed,
  useUnreachableKafka,
} from './support/test-app';
import { FLOW_PASSWORD, loginAs, registerAndLogin } from './support/token-flow';

jest.setTimeout(180_000);

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change-me-now-123';
const CUSTOMER_EMAIL = 'ana@example.com';

/** Status changes never need Kafka and publish no event. */
describe('PATCH /users/{id}/status with Kafka unreachable (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let app: INestApplication;

  beforeAll(async () => {
    postgres = await startPostgres();
    await useUnreachableKafka();
    useAdminSeed({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    app = await createTestApp();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    await postgres?.stop();
    process.env = savedEnv;
  });

  it('should disable and re-enable a user without attempting any publish', async () => {
    const { accessToken } = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const customer = await registerAndLogin(app, CUSTOMER_EMAIL);
    // Registration itself tries to publish; only the calls below must not.
    const publish = jest.spyOn(LazyKafkaProducer.prototype, 'publish');

    const patchStatus = (status: string): request.Test =>
      request(app.getHttpServer())
        .patch(`/users/${customer.userId}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status });
    const login = (): request.Test =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: CUSTOMER_EMAIL, password: FLOW_PASSWORD });

    await patchStatus('DISABLED').expect(200);
    await login().expect(401);
    await patchStatus('ACTIVE').expect(200);
    await login().expect(200);

    expect(publish).not.toHaveBeenCalled();
  });
});
