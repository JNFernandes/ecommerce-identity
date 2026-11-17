import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';

jest.setTimeout(180_000);

const PASSWORD = 'correct-horse-battery';

/** Login never depends on Kafka (FR-014, SC-007). */
describe('POST /auth/login with Kafka unreachable (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should log in a user who registered while Kafka was down', async () => {
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'ana@example.com', name: 'Ana', password: PASSWORD });
    expect(registered.status).toBe(201);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ana@example.com', password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
  });
});
