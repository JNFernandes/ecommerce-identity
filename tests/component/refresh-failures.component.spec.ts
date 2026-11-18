import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestApp, startPostgres, useUnreachableKafka } from './support/test-app';
import {
  familyRows,
  postRefresh,
  registerAndLogin,
  rowOf,
  sha256,
  TokenPair,
} from './support/token-flow';

jest.setTimeout(180_000);

const GENERIC_401 = '{"message":"invalid refresh token","error":"Unauthorized","statusCode":401}';

describe('refresh failures (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    app = await createTestApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  describe('token and account failures', () => {
    const bodies: Record<string, string> = {};
    let expiredFamily: string;
    let disabledFamily: string;
    let expiredToken: string;

    beforeAll(async () => {
      bodies.unknown = (await postRefresh(app, 'never-issued-token-value')).text;

      const expired = await registerAndLogin(app, 'expired@example.com');
      expiredToken = expired.tokens.refreshToken;
      await dataSource.query(
        `UPDATE "refresh_tokens" SET "expiresAt" = now() - interval '1 minute' WHERE "tokenHash" = $1`,
        [sha256(expiredToken)],
      );
      expiredFamily = (await rowOf(dataSource, expiredToken))?.familyId ?? '';
      bodies.expired = (await postRefresh(app, expiredToken)).text;

      const reused = await registerAndLogin(app, 'reused@example.com');
      await postRefresh(app, reused.tokens.refreshToken);
      bodies.reused = (await postRefresh(app, reused.tokens.refreshToken)).text;

      const disabled = await registerAndLogin(app, 'disabled@example.com');
      await dataSource.query(`UPDATE "users" SET "status" = 'DISABLED' WHERE "id" = $1`, [
        disabled.userId,
      ]);
      disabledFamily = (await rowOf(dataSource, disabled.tokens.refreshToken))?.familyId ?? '';
      bodies.disabled = (await postRefresh(app, disabled.tokens.refreshToken)).text;
    });

    it.each(['unknown', 'expired', 'reused', 'disabled'])(
      'should answer a %s token with the byte-identical generic 401 body',
      (cause) => {
        expect(bodies[cause]).toBe(GENERIC_401);
      },
    );

    it('should revoke the family of a disabled user', async () => {
      const rows = await familyRows(dataSource, disabledFamily);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    });

    it('should not revoke the family of an expired, unused token', async () => {
      const rows = await familyRows(dataSource, expiredFamily);
      expect(rows).toHaveLength(1);
      expect(rows[0].revokedAt).toBeNull();
    });

    it('should not issue any token for a failed refresh', async () => {
      const rows = await familyRows(dataSource, expiredFamily);
      expect(rows.map((row) => row.tokenHash)).toEqual([sha256(expiredToken)]);
    });
  });

  describe('validation', () => {
    it.each([
      ['a missing field', {}],
      ['a number', { refreshToken: 42 }],
      ['an empty string', { refreshToken: '' }],
      ['an unknown property', { refreshToken: 'abc', extra: true }],
    ])('should answer %s with 400', async (_case, body) => {
      const response = await request(app.getHttpServer()).post('/auth/refresh').send(body);

      expect(response.status).toBe(400);
    });

    it('should answer malformed JSON with 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Content-Type', 'application/json')
        .send('{"refreshToken":');

      expect(response.status).toBe(400);
    });

    it('should still refresh a valid token after rejected bodies', async () => {
      const { tokens } = await registerAndLogin(app, 'after-400@example.com');

      const response = await postRefresh(app, tokens.refreshToken);

      expect(response.status).toBe(200);
      expect((response.body as TokenPair).refreshToken).toBeDefined();
    });
  });
});
