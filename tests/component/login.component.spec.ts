import { createHash, KeyObject } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  exportJWK,
  JWTPayload,
  jwtVerify,
} from 'jose';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestApp,
  startPostgres,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  useTestSigningKey,
  useUnreachableKafka,
} from './support/test-app';

jest.setTimeout(180_000);

const PASSWORD = 'correct-horse-battery';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface TokenRow {
  userId: string;
  familyId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface LoginBody {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

describe('POST /auth/login (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let publicKey: KeyObject;
  let app: INestApplication;
  let dataSource: DataSource;
  let userId: string;
  let customerId: string;
  let first: request.Response;
  let second: request.Response;

  const login = (email: string): request.Test =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password: PASSWORD });

  const verify = async (token: string): Promise<{ payload: JWTPayload }> =>
    jwtVerify(token, publicKey, {
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      algorithms: ['RS256'],
    });

  beforeAll(async () => {
    container = await startPostgres();
    publicKey = useTestSigningKey().publicKey;
    await useUnreachableKafka();
    app = await createTestApp();
    dataSource = app.get(DataSource);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'ana@example.com', name: 'Ana', password: PASSWORD });
    expect(registered.status).toBe(201);
    ({ id: userId, customerId } = registered.body as { id: string; customerId: string });

    first = await login(' Ana@Example.com ');
    second = await login('ana@example.com');
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should return 200 with exactly the four fields', () => {
    expect(first.status).toBe(200);
    expect(Object.keys(first.body as object).sort()).toEqual(
      ['accessToken', 'expiresIn', 'refreshToken', 'tokenType'].sort(),
    );
    const body = first.body as LoginBody;
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(900);
    expect(body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('should sign the access token with the configured key and its thumbprint as kid', async () => {
    const { accessToken } = first.body as LoginBody;

    expect(decodeProtectedHeader(accessToken)).toEqual({
      alg: 'RS256',
      kid: await calculateJwkThumbprint(await exportJWK(publicKey), 'sha256'),
      typ: 'JWT',
    });
    await expect(verify(accessToken)).resolves.toBeDefined();
  });

  it('should carry exactly the contract claims', async () => {
    const { payload } = await verify((first.body as LoginBody).accessToken);

    expect(payload).toEqual({
      sub: userId,
      customerId,
      roles: ['CUSTOMER'],
      iss: TEST_JWT_ISSUER,
      aud: TEST_JWT_AUDIENCE,
      iat: expect.any(Number),
      exp: (payload.iat ?? 0) + 900,
      jti: expect.stringMatching(UUID),
    });
  });

  it('should issue different tokens and families on two logins', async () => {
    const a = first.body as LoginBody;
    const b = second.body as LoginBody;
    const [claimsA, claimsB] = await Promise.all([verify(a.accessToken), verify(b.accessToken)]);
    const rows: TokenRow[] = await dataSource.query('SELECT "familyId" FROM "refresh_tokens"');

    expect(second.status).toBe(200);
    expect(claimsB.payload.jti).not.toBe(claimsA.payload.jti);
    expect(b.refreshToken).not.toBe(a.refreshToken);
    expect(rows).toHaveLength(2);
    expect(rows[1].familyId).not.toBe(rows[0].familyId);
  });

  it('should store only the SHA-256 hash of the refresh token, valid for 7 days', async () => {
    const { refreshToken } = first.body as LoginBody;
    const hash = createHash('sha256').update(refreshToken).digest('hex');

    const rows: TokenRow[] = await dataSource.query(
      'SELECT "userId", "tokenHash", "createdAt", "expiresAt", "revokedAt" FROM "refresh_tokens" WHERE "tokenHash" = $1',
      [hash],
    );
    const stored: unknown[] = await dataSource.query(
      'SELECT 1 FROM "refresh_tokens" WHERE "tokenHash" = $1',
      [refreshToken],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].revokedAt).toBeNull();
    expect(rows[0].expiresAt.getTime() - rows[0].createdAt.getTime()).toBe(SEVEN_DAYS_MS);
    expect(stored).toEqual([]);
  });

  it('should record the last login time', async () => {
    const [user]: { lastLoginAt: Date | null }[] = await dataSource.query(
      'SELECT "lastLoginAt" FROM "users" WHERE "id" = $1',
      [userId],
    );

    expect(user.lastLoginAt).toBeInstanceOf(Date);
  });
});
