import { INestApplication } from '@nestjs/common';
import { createLocalJWKSet, decodeJwt, JSONWebKeySet, jwtVerify, JWTPayload } from 'jose';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestApp,
  startPostgres,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  useUnreachableKafka,
} from './support/test-app';
import {
  familyRows,
  LoggedInCustomer,
  postRefresh,
  registerAndLogin,
  rowOf,
  TokenPair,
} from './support/token-flow';

jest.setTimeout(180_000);

describe('POST /auth/refresh (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let dataSource: DataSource;

  /** Verifies an access token against the service's own JWKS. */
  async function verifyThroughJwks(token: string): Promise<JWTPayload> {
    const jwks = await request(app.getHttpServer()).get('/.well-known/jwks.json');
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks.body as JSONWebKeySet), {
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      algorithms: ['RS256'],
    });
    return payload;
  }

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

  describe('a successful refresh', () => {
    let customer: LoggedInCustomer;
    let response: request.Response;
    let refreshed: TokenPair;

    beforeAll(async () => {
      customer = await registerAndLogin(app, 'refresh@example.com');
      response = await postRefresh(app, customer.tokens.refreshToken);
      refreshed = response.body as TokenPair;
    });

    it('should return 200 with exactly the four login fields', () => {
      expect(response.status).toBe(200);
      expect(Object.keys(refreshed).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshToken',
        'tokenType',
      ]);
      expect(refreshed.tokenType).toBe('Bearer');
      expect(refreshed.expiresIn).toBe(900);
      expect(refreshed.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(refreshed.refreshToken).not.toBe(customer.tokens.refreshToken);
    });

    it('should issue an access token with the login claim set and a new jti', async () => {
      const payload = await verifyThroughJwks(refreshed.accessToken);
      const loginPayload = decodeJwt(customer.tokens.accessToken);

      expect(Object.keys(payload).sort()).toEqual(Object.keys(loginPayload).sort());
      expect(payload.sub).toBe(customer.userId);
      expect(payload.customerId).toBe(customer.customerId);
      expect(payload.roles).toEqual(['CUSTOMER']);
      expect(payload.jti).not.toBe(loginPayload.jti);
    });

    it('should mark the presented token used and store the successor as a hash in the family', async () => {
      const old = await rowOf(dataSource, customer.tokens.refreshToken);
      const next = await rowOf(dataSource, refreshed.refreshToken);

      expect(next).toBeDefined();
      expect(old?.revokedAt).toBeInstanceOf(Date);
      expect(old?.replacedBy).toBe(next?.id);
      expect(next?.familyId).toBe(old?.familyId);
      expect(next?.userId).toBe(customer.userId);
      expect(next?.revokedAt).toBeNull();
      const rows = await familyRows(dataSource, old?.familyId ?? '');
      expect(JSON.stringify(rows)).not.toContain(refreshed.refreshToken);
    });
  });

  it('should let each token of a chain of refreshes succeed exactly once', async () => {
    const customer = await registerAndLogin(app, 'chain@example.com');
    let current = customer.tokens.refreshToken;

    for (let step = 0; step < 3; step += 1) {
      const response = await postRefresh(app, current);
      expect(response.status).toBe(200);
      current = (response.body as TokenPair).refreshToken;
    }

    const family = (await rowOf(dataSource, current))?.familyId ?? '';
    const rows = await familyRows(dataSource, family);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  it('should refuse the presented token once it has been used', async () => {
    const customer = await registerAndLogin(app, 'used@example.com');
    expect((await postRefresh(app, customer.tokens.refreshToken)).status).toBe(200);

    expect((await postRefresh(app, customer.tokens.refreshToken)).status).toBe(401);
  });

  it('should read roles and customerId from the current user record', async () => {
    const customer = await registerAndLogin(app, 'roles@example.com');
    await dataSource.query(
      `UPDATE "users" SET "roles" = ARRAY['CUSTOMER','ADMIN']::user_role_enum[] WHERE "id" = $1`,
      [customer.userId],
    );

    const response = await postRefresh(app, customer.tokens.refreshToken);

    expect(response.status).toBe(200);
    const payload = await verifyThroughJwks((response.body as TokenPair).accessToken);
    expect(payload.roles).toEqual(['CUSTOMER', 'ADMIN']);
    expect(payload.customerId).toBe(customer.customerId);
  });
});
