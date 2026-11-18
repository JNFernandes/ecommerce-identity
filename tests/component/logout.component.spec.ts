import { INestApplication } from '@nestjs/common';
import { createLocalJWKSet, JSONWebKeySet, jwtVerify } from 'jose';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TopicObserver } from './support/kafka-testing';
import {
  createTestApp,
  startPostgres,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from './support/test-app';
import {
  familyRows,
  postLogout,
  postRefresh,
  registerAndLogin,
  rowOf,
  sha256,
  TokenPair,
} from './support/token-flow';

jest.setTimeout(240_000);

const TOPIC = 'identity.user-registered';

/**
 * Runs against real PostgreSQL and real Kafka, so the whole token flow
 * (register → login → refresh → logout) is exercised as in production (constitution VII).
 */
describe('POST /auth/logout (component)', () => {
  const savedEnv = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let kafka: StartedKafkaContainer;
  let observer: TopicObserver;
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    [postgres, kafka] = await Promise.all([
      startPostgres(),
      new KafkaContainer('confluentinc/cp-kafka:7.6.1').start(),
    ]);
    const broker = `${kafka.getHost()}:${kafka.getMappedPort(9093)}`;
    process.env.KAFKA_BROKERS = broker;
    observer = await TopicObserver.start(broker, TOPIC);
    app = await createTestApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await observer?.stop();
    await app?.close();
    await Promise.all([kafka?.stop(), postgres?.stop()]);
    process.env = savedEnv;
  });

  describe('the full token flow', () => {
    let accessBeforeLogout: string;
    let latest: string;
    let familyId: string;
    let replacedBefore: (string | null)[];
    let logout: request.Response;

    beforeAll(async () => {
      const { tokens } = await registerAndLogin(app, 'flow@example.com');
      await observer.waitForMessages(1);
      const refreshed = await postRefresh(app, tokens.refreshToken);
      expect(refreshed.status).toBe(200);
      ({ refreshToken: latest, accessToken: accessBeforeLogout } = refreshed.body as TokenPair);
      familyId = (await rowOf(dataSource, latest))?.familyId ?? '';
      replacedBefore = (await familyRows(dataSource, familyId)).map((row) => row.replacedBy);

      logout = await postLogout(app, latest);
    });

    it('should publish the registration event on the real broker', () => {
      expect(observer.messages.length).toBeGreaterThanOrEqual(1);
    });

    it('should answer 204 with an empty body', () => {
      expect(logout.status).toBe(204);
      expect(logout.text).toBe('');
    });

    it('should revoke every token of the family and leave replacedBy unchanged', async () => {
      const rows = await familyRows(dataSource, familyId);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      expect(rows.map((row) => row.replacedBy)).toEqual(replacedBefore);
    });

    it('should refuse to refresh with the logged-out token', async () => {
      expect((await postRefresh(app, latest)).status).toBe(401);
    });

    it('should keep an access token issued before logout valid until it expires', async () => {
      const jwks = await request(app.getHttpServer()).get('/.well-known/jwks.json');

      await expect(
        jwtVerify(accessBeforeLogout, createLocalJWKSet(jwks.body as JSONWebKeySet), {
          issuer: TEST_JWT_ISSUER,
          audience: TEST_JWT_AUDIENCE,
          algorithms: ['RS256'],
        }),
      ).resolves.toBeDefined();
    });
  });

  it('should answer 204 for an unknown token', async () => {
    const response = await postLogout(app, 'never-issued-token-value');

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
  });

  it('should answer 204 for an already revoked token and change nothing', async () => {
    const { tokens } = await registerAndLogin(app, 'twice@example.com');
    expect((await postLogout(app, tokens.refreshToken)).status).toBe(204);
    const before = await rowOf(dataSource, tokens.refreshToken);

    expect((await postLogout(app, tokens.refreshToken)).status).toBe(204);

    expect(await rowOf(dataSource, tokens.refreshToken)).toEqual(before);
  });

  it('should answer 204 for an expired token and revoke its family', async () => {
    const { tokens } = await registerAndLogin(app, 'expired-logout@example.com');
    await dataSource.query(
      `UPDATE "refresh_tokens" SET "expiresAt" = now() - interval '1 minute' WHERE "tokenHash" = $1`,
      [sha256(tokens.refreshToken)],
    );

    expect((await postLogout(app, tokens.refreshToken)).status).toBe(204);
    expect((await rowOf(dataSource, tokens.refreshToken))?.revokedAt).not.toBeNull();
  });

  it.each([
    ['an unknown property', { refreshToken: 'abc', extra: true }],
    ['a missing field', {}],
    ['a number', { refreshToken: 42 }],
  ])('should answer %s with 400', async (_case, body) => {
    const response = await request(app.getHttpServer()).post('/auth/logout').send(body);

    expect(response.status).toBe(400);
  });

  it('should answer malformed JSON with 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Content-Type', 'application/json')
      .send('{"refreshToken":');

    expect(response.status).toBe(400);
  });
});
