import { INestApplication } from '@nestjs/common';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  JSONWebKeySet,
  jwtVerify,
} from 'jose';
import { KeyObject } from 'node:crypto';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestApp,
  startPostgres,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  tempKeyDir,
  TestKeyPair,
  useActiveKey,
  useRetiredPublicKeys,
  useUnreachableKafka,
  writeTestKeyPair,
} from './support/test-app';

jest.setTimeout(180_000);

const PATH = '/.well-known/jwks.json';
const EMAIL = 'rotation@example.com';
const PASSWORD = 'correct-horse-battery';

/** RFC 7638 thumbprint of a public key: the `kid` the service derives for it. */
async function kidOf(publicKey: KeyObject): Promise<string> {
  return calculateJwkThumbprint(await exportJWK(publicKey), 'sha256');
}

/** US-03 / US-2: rotate the signing key across restarts without breaking live tokens. */
describe('JWKS key rotation (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication | undefined;
  let keyA: TestKeyPair;
  let keyB: TestKeyPair;
  let tokenA: string;

  /** Restarts the app with the given active key and retired public key paths. */
  async function restart(active: TestKeyPair, retired: readonly string[]): Promise<void> {
    await app?.close();
    useActiveKey(active);
    useRetiredPublicKeys(retired);
    app = await createTestApp();
  }

  const server = (): ReturnType<INestApplication['getHttpServer']> => {
    if (app === undefined) {
      throw new Error('app not started');
    }
    return app.getHttpServer();
  };

  /** Logs in the test user and returns the access token. */
  async function login(): Promise<string> {
    const response = await request(server())
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  const fetchKeySet = async (): Promise<JSONWebKeySet> =>
    (await request(server()).get(PATH).expect(200)).body as JSONWebKeySet;

  const verify = (token: string, jwks: JSONWebKeySet): ReturnType<typeof jwtVerify> =>
    jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      algorithms: ['RS256'],
    });

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    const dir = tempKeyDir();
    keyA = writeTestKeyPair(dir, 'a');
    keyB = writeTestKeyPair(dir, 'b');

    await restart(keyA, []);
    await request(server())
      .post('/auth/register')
      .send({ email: EMAIL, name: 'Rotation', password: PASSWORD })
      .expect(201);
    tokenA = await login();
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should sign with key A before rotation', async () => {
    expect(decodeProtectedHeader(tokenA).kid).toBe(await kidOf(keyA.publicKey));
  });

  it('should publish B then A after rotation, sign with B and still verify the A token', async () => {
    await restart(keyB, [keyA.publicKeyPath]);

    const jwks = await fetchKeySet();
    const tokenB = await login();

    expect(jwks.keys.map((key) => key.kid)).toEqual([
      await kidOf(keyB.publicKey),
      await kidOf(keyA.publicKey),
    ]);
    expect(decodeProtectedHeader(tokenB).kid).toBe(await kidOf(keyB.publicKey));
    await expect(verify(tokenB, jwks)).resolves.toBeDefined();
    await expect(verify(tokenA, jwks)).resolves.toBeDefined();
  });

  it('should drop A once it is no longer retired, so the A token fails verification', async () => {
    await restart(keyB, []);

    const jwks = await fetchKeySet();

    expect(jwks.keys.map((key) => key.kid)).toEqual([await kidOf(keyB.publicKey)]);
    await expect(verify(tokenA, jwks)).rejects.toThrow();
    await expect(verify(await login(), jwks)).resolves.toBeDefined();
  });
});
