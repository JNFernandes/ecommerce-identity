import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapturingLogger } from './support/capturing-logger';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import { postLogout, postRefresh, registerAndLogin, sha256, TokenPair } from './support/token-flow';

jest.setTimeout(180_000);

const BEARER = 'Bearer header-value-that-must-not-be-logged';

/**
 * Runs every refresh and logout outcome (success, reuse, unknown, 400, 429, logout) and checks
 * that no log line or error body contains a token, a token hash or an `Authorization` header.
 */
describe('refresh and logout log hygiene (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  const secrets: string[] = [BEARER];
  const errorBodies: string[] = [];
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;

  /** Records a token value and its hash as secrets. */
  function remember(value: string): void {
    secrets.push(value, sha256(value));
  }

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    process.env.RATE_LIMIT_REFRESH_LIMIT = '6';
    app = await createTestApp(logger);

    const { tokens } = await registerAndLogin(app, 'logs@example.com');
    remember(tokens.refreshToken);
    secrets.push(tokens.accessToken);

    const success = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Authorization', BEARER)
      .send({ refreshToken: tokens.refreshToken });
    const next = success.body as TokenPair;
    remember(next.refreshToken);
    secrets.push(next.accessToken);

    const unknown = 'unknown-token-value-0123456789';
    remember(unknown);
    const responses = [
      await postRefresh(app, tokens.refreshToken), // reuse
      await postRefresh(app, unknown),
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: tokens.refreshToken, extra: true }), // 400
      await postLogout(app, next.refreshToken),
      await postLogout(app, unknown),
    ];
    // Exhaust the refresh bucket (6 per window) to get a 429.
    let throttled = await postRefresh(app, unknown);
    while (throttled.status !== 429) {
      throttled = await postRefresh(app, unknown);
    }
    responses.push(throttled);
    for (const response of responses) {
      if (response.status >= 400) {
        errorBodies.push(response.text);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should have logged the refresh, reuse and logout events', () => {
    const text = logger.text();
    expect(text).toContain('refresh succeeded');
    expect(text).toContain('refresh token reuse detected');
    expect(text).toContain('refresh refused: reason=UNKNOWN');
    expect(text).toContain('logout:');
  });

  it('should have collected 400, 401 and 429 error bodies', () => {
    expect(errorBodies.length).toBeGreaterThanOrEqual(4);
  });

  it('should never log a token, a token hash or an Authorization header', () => {
    const text = logger.text();
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
  });

  it('should never put a token, a token hash or an Authorization header in an error body', () => {
    const bodies = errorBodies.join('\n');
    for (const secret of secrets) {
      expect(bodies).not.toContain(secret);
    }
  });
});
