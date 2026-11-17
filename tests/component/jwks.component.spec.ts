import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { INestApplication } from '@nestjs/common';
import { createLocalJWKSet, decodeProtectedHeader, JSONWebKeySet, jwtVerify, SignJWT } from 'jose';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestApp,
  startPostgres,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TestKeyPair,
  useTestSigningKey,
  useUnreachableKafka,
} from './support/test-app';

jest.setTimeout(180_000);

const PATH = '/.well-known/jwks.json';
const PASSWORD = 'correct-horse-battery';
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];

/** US-03 / US-1: downstream services fetch the public keys and verify tokens offline. */
describe('GET /.well-known/jwks.json (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let keyPair: TestKeyPair;
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    container = await startPostgres();
    keyPair = useTestSigningKey();
    // Kafka points at a closed port for the whole suite: the endpoint must not need it.
    await useUnreachableKafka();
    app = await createTestApp();

    const server = app.getHttpServer();
    await request(server)
      .post('/auth/register')
      .send({ email: 'ana@example.com', name: 'Ana', password: PASSWORD })
      .expect(201);
    const login = await request(server)
      .post('/auth/login')
      .send({ email: 'ana@example.com', password: PASSWORD })
      .expect(200);
    ({ accessToken } = login.body as { accessToken: string });
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  const fetchKeySet = (): request.Test => request(app.getHttpServer()).get(PATH);

  it('should return 200 with the active key as exactly six public members', async () => {
    const response = await fetchKeySet().expect(200);

    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    const { keys } = response.body as { keys: Record<string, unknown>[] };
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0])).toEqual(['kty', 'use', 'alg', 'kid', 'n', 'e']);
    expect(keys[0]).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256', e: 'AQAB' });
    for (const member of PRIVATE_MEMBERS) {
      expect(keys[0]).not.toHaveProperty(member);
    }
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  it('should publish the kid of issued tokens, which verify with only the fetched keys', async () => {
    const response = await fetchKeySet().expect(200);
    const jwks = response.body as JSONWebKeySet;

    expect(jwks.keys[0].kid).toBe(decodeProtectedHeader(accessToken).kid);
    const { payload, protectedHeader } = await jwtVerify(accessToken, createLocalJWKSet(jwks), {
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      algorithms: ['RS256'],
    });
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.roles).toEqual(['CUSTOMER']);
  });

  it('should ignore any Authorization header', async () => {
    const expired = await new SignJWT({ roles: ['CUSTOMER'] })
      .setProtectedHeader({ alg: 'RS256', kid: decodeProtectedHeader(accessToken).kid })
      .setIssuer(TEST_JWT_ISSUER)
      .setAudience(TEST_JWT_AUDIENCE)
      .setIssuedAt(1_000)
      .setExpirationTime(1_900)
      .sign(createPrivateKey(readFileSync(keyPair.privateKeyPath)));
    const anonymous = await fetchKeySet().expect(200);

    for (const authorization of [
      `Bearer ${accessToken}`,
      'Bearer not-a-token',
      `Bearer ${expired}`,
    ]) {
      const response = await fetchKeySet().set('Authorization', authorization).expect(200);
      expect(response.text).toBe(anonymous.text);
    }
  });

  it('should answer HEAD with the same headers and no body', async () => {
    const get = await fetchKeySet().expect(200);

    const head = await request(app.getHttpServer()).head(PATH).expect(200);

    for (const header of ['content-type', 'content-length', 'cache-control', 'etag']) {
      expect(head.headers[header]).toBe(get.headers[header]);
    }
    expect(head.text ?? '').toBe('');
  });

  it('should not serve POST and leak no key data', async () => {
    const keySet = await fetchKeySet().expect(200);

    const response = await request(app.getHttpServer()).post(PATH).send({}).expect(404);

    expect(response.text).not.toContain('"kid"');
    expect(response.text).not.toContain('RS256');
    expect(response.headers.etag).not.toBe(keySet.headers.etag);
    expect(response.headers['cache-control']).toBeUndefined();
  });
});
