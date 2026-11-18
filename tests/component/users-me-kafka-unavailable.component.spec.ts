import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import { registerAndLogin } from './support/token-flow';

jest.setTimeout(180_000);

/** `GET /users/me` never depends on Kafka (FR-015, SC-007). */
describe('GET /users/me with Kafka unreachable (component)', () => {
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

  it('should return the account of a user who logged in while Kafka was down', async () => {
    const { userId, tokens } = await registerAndLogin(app, 'kafka-down@example.com');

    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`);

    expect(response.status).toBe(200);
    expect((response.body as { id: string }).id).toBe(userId);
  });
});
