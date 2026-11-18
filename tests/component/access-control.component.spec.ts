import { createPrivateKey, KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { INestApplication } from '@nestjs/common';
import { base64url, decodeProtectedHeader, JWTPayload, SignJWT } from 'jose';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestApp,
  startPostgres,
  tempKeyDir,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TestKeyPair,
  useRetiredPublicKeys,
  useTestSigningKey,
  useUnreachableKafka,
  writeTestKeyPair,
} from './support/test-app';
import { LoggedInCustomer, registerAndLogin } from './support/token-flow';

jest.setTimeout(180_000);

const GENERIC_401 = '{"statusCode":401,"message":"unauthorized","error":"Unauthorized"}';

interface ForgeOptions {
  claims?: Record<string, unknown>;
  omit?: string[];
  header?: Record<string, unknown>;
  key?: KeyObject;
}

function privateKeyOf(pair: TestKeyPair): KeyObject {
  return createPrivateKey(readFileSync(pair.privateKeyPath, 'utf8'));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Every way a request can fail to present a trustworthy access token gets the same 401 (US2).
 * Tokens are forged in the test with the app's own test keys.
 */
describe('access token rejection matrix (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let active: TestKeyPair;
  let retired: TestKeyPair;
  let activeKid: string;
  let retiredKid: string;
  let customer: LoggedInCustomer;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    active = useTestSigningKey();
    retired = writeTestKeyPair(tempKeyDir(), 'retired');
    useRetiredPublicKeys([retired.publicKeyPath]);
    app = await createTestApp();
    customer = await registerAndLogin(app, 'matrix@example.com');
    activeKid = decodeProtectedHeader(customer.tokens.accessToken).kid ?? '';
    const jwks = await request(app.getHttpServer()).get('/.well-known/jwks.json');
    const kids = (jwks.body as { keys: { kid: string }[] }).keys.map((key) => key.kid);
    expect(kids[0]).toBe(activeKid);
    retiredKid = kids[1];
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  function claims(overrides: Record<string, unknown> = {}, omit: string[] = []): JWTPayload {
    const now = nowSeconds();
    const payload: JWTPayload = {
      sub: customer.userId,
      customerId: customer.customerId,
      roles: ['CUSTOMER'],
      iss: TEST_JWT_ISSUER,
      aud: TEST_JWT_AUDIENCE,
      iat: now,
      exp: now + 900,
      jti: 'c0ffee00-0000-4000-8000-000000000000',
      ...overrides,
    };
    for (const name of omit) {
      delete payload[name];
    }
    return payload;
  }

  async function forge(options: ForgeOptions = {}): Promise<string> {
    return new SignJWT(claims(options.claims, options.omit))
      .setProtectedHeader({ alg: 'RS256', kid: activeKid, typ: 'JWT', ...options.header })
      .sign(options.key ?? privateKeyOf(active));
  }

  function me(authorization?: string): request.Test {
    const test = request(app.getHttpServer()).get('/users/me');
    return authorization === undefined ? test : test.set('Authorization', authorization);
  }

  async function expectGeneric401(
    authorization: string | undefined,
    token?: string,
  ): Promise<void> {
    const response = await me(authorization);
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.text).toBe(GENERIC_401);
    if (token !== undefined && token !== '') {
      expect(response.text).not.toContain(token);
    }
  }

  describe('rejected header forms', () => {
    it.each([
      ['no header', undefined],
      ['Basic', 'Basic dXNlcjpwYXNz'],
      ['empty Bearer', 'Bearer '],
      ['extra spaces', 'Bearer  abc.def.ghi'],
      ['two tokens', 'Bearer abc.def.ghi abc.def.ghi'],
      ['a non-JWT value', 'Bearer not-a-jwt'],
    ])('should refuse %s', async (_label, authorization) => {
      await expectGeneric401(authorization);
    });

    it('should refuse a refresh token used as a Bearer token', async () => {
      const token = customer.tokens.refreshToken;
      await expectGeneric401(`Bearer ${token}`, token);
    });
  });

  describe('rejected tokens', () => {
    it('should refuse alg none', async () => {
      const header = base64url.encode(JSON.stringify({ alg: 'none', kid: activeKid, typ: 'JWT' }));
      const payload = base64url.encode(JSON.stringify(claims({ roles: ['ADMIN'] })));
      const token = `${header}.${payload}.`;
      await expectGeneric401(`Bearer ${token}`, token);
    });

    it('should refuse HS256 signed with the public key PEM as the secret', async () => {
      const secret = new TextEncoder().encode(readFileSync(active.publicKeyPath, 'utf8'));
      const token = await new SignJWT(claims())
        .setProtectedHeader({ alg: 'HS256', kid: activeKid, typ: 'JWT' })
        .sign(secret);
      await expectGeneric401(`Bearer ${token}`, token);
    });

    it('should refuse a tampered payload', async () => {
      const [header, , signature] = customer.tokens.accessToken.split('.');
      const payload = base64url.encode(JSON.stringify(claims({ roles: ['ADMIN'] })));
      const token = `${header}.${payload}.${signature}`;
      await expectGeneric401(`Bearer ${token}`, token);
    });

    it('should refuse a missing kid', async () => {
      const token = await new SignJWT(claims())
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .sign(privateKeyOf(active));
      await expectGeneric401(`Bearer ${token}`, token);
    });

    it.each<[string, ForgeOptions]>([
      ['an unknown kid', { header: { kid: 'unknown-kid' } }],
      ['a wrong issuer', { claims: { iss: 'someone-else' } }],
      ['a wrong audience', { claims: { aud: 'another-service' } }],
      ['exp beyond the tolerance', { claims: { iat: nowSeconds() - 900, exp: nowSeconds() - 60 } }],
      ['a missing jti', { omit: ['jti'] }],
      ['an unknown role', { claims: { roles: ['ROOT'] } }],
    ])('should refuse %s', async (_label, options) => {
      const token = await forge(options);
      await expectGeneric401(`Bearer ${token}`, token);
    });

    it('should give byte-identical bodies for different failures', async () => {
      const wrongAudience = await forge({ claims: { aud: 'x' } });
      const responses = await Promise.all([
        me(),
        me('Bearer not-a-jwt'),
        me(`Bearer ${wrongAudience}`),
      ]);
      expect(new Set(responses.map((response) => response.text)).size).toBe(1);
    });
  });

  describe('accepted tokens', () => {
    it('should accept a lower-case bearer scheme', async () => {
      const response = await me(`bearer ${customer.tokens.accessToken}`);
      expect(response.status).toBe(200);
    });

    it('should accept exp within the clock tolerance', async () => {
      const now = nowSeconds();
      const token = await forge({ claims: { iat: now - 900, exp: now - 2 } });
      const response = await me(`Bearer ${token}`);
      expect(response.status).toBe(200);
    });

    it('should accept a token signed by a retired published key', async () => {
      const token = await forge({ header: { kid: retiredKid }, key: privateKeyOf(retired) });
      const response = await me(`Bearer ${token}`);
      expect(response.status).toBe(200);
      expect((response.body as { id: string }).id).toBe(customer.userId);
    });
  });
});
