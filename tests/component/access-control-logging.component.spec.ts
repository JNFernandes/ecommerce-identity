import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AdminProbeController } from './support/admin-probe.controller';
import { CapturingLogger } from './support/capturing-logger';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import { registerAndLogin } from './support/token-flow';

jest.setTimeout(180_000);

/** No access token, refresh token or `Authorization` value reaches the logs (FR-013, SC-006). */
describe('access control logging (component)', () => {
  const savedEnv = { ...process.env };
  const logger = new CapturingLogger();
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  const secrets: string[] = [];
  const bodies: string[] = [];

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    app = await createTestApp(logger, [], { extraControllers: [AdminProbeController] });

    const { tokens } = await registerAndLogin(app, 'logging@example.com');
    const [header, payload, signature] = tokens.accessToken.split('.');
    const tampered = `${header}.${payload}x.${signature}`;
    const authorizations = [
      `Bearer ${tokens.accessToken}`,
      `Bearer ${tampered}`,
      `Bearer ${tokens.refreshToken}`,
      'Basic do-not-log-this-basic-value',
      'Bearer not-a-jwt-do-not-log',
    ];
    secrets.push(
      tokens.accessToken,
      tokens.refreshToken,
      tampered,
      signature,
      'do-not-log-this-basic-value',
      'not-a-jwt-do-not-log',
    );

    const get = (path: string, authorization?: string): request.Test => {
      const test = request(app.getHttpServer()).get(path);
      return authorization === undefined ? test : test.set('Authorization', authorization);
    };
    const responses = [
      await get('/users/me', authorizations[0]),
      await get('/test/admin-probe', authorizations[0]),
      await get('/users/me'),
      ...(await Promise.all(authorizations.slice(1).map((value) => get('/users/me', value)))),
    ];
    expect(responses.map((response) => response.status)).toEqual([
      200, 403, 401, 401, 401, 401, 401,
    ]);
    bodies.push(...responses.map((response) => response.text));
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should keep every token and Authorization value out of the logs and error bodies', () => {
    const logs = logger.text();
    const errorBodies = bodies.slice(1).join('\n');
    for (const secret of secrets) {
      expect(logs).not.toContain(secret);
      expect(errorBodies).not.toContain(secret);
    }
    expect(logs).not.toMatch(/Bearer |Basic /);
  });

  it('should log the failure reason at warn', () => {
    const warnings = logger.lines.filter((line) => line.startsWith('[warn]'));

    expect(warnings.some((line) => line.includes('reason=MISSING_HEADER'))).toBe(true);
    expect(warnings.some((line) => line.includes('reason=INVALID_SIGNATURE'))).toBe(true);
    expect(warnings.some((line) => line.includes('reason=MALFORMED_HEADER'))).toBe(true);
    expect(warnings.some((line) => line.includes('reason=MALFORMED_TOKEN'))).toBe(true);
  });
});
