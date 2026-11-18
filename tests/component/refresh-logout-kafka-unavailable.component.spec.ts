import { INestApplication } from '@nestjs/common';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import { postLogout, postRefresh, registerAndLogin, TokenPair } from './support/token-flow';

jest.setTimeout(180_000);

describe('refresh and logout with Kafka unreachable (component)', () => {
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

  it('should refresh and log out while the broker is down', async () => {
    const { tokens } = await registerAndLogin(app, 'no-kafka@example.com');

    const refreshed = await postRefresh(app, tokens.refreshToken);
    expect(refreshed.status).toBe(200);

    const logout = await postLogout(app, (refreshed.body as TokenPair).refreshToken);
    expect(logout.status).toBe(204);
  });
});
