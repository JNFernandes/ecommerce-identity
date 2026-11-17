import { generateKeyPairSync } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { decodeProtectedHeader, JSONWebKeySet, SignJWT } from 'jose';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ReferenceVerifier, REFETCH_INTERVAL_MS } from '../support/reference-verifier';
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

const EMAIL = 'verifier@example.com';
const PASSWORD = 'correct-horse-battery';

/** US-03 / US-5: the reference verifier, fetching the real endpoint, enforces the contract. */
describe('reference verifier against the running service (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;
  let app: INestApplication | undefined;
  let keyA: TestKeyPair;
  let keyB: TestKeyPair;
  let now = Date.now();

  const server = (): ReturnType<INestApplication['getHttpServer']> => {
    if (app === undefined) {
      throw new Error('app not started');
    }
    return app.getHttpServer();
  };

  /** Fetches the key set from whichever app instance is currently running. */
  const fetchKeySet = async (): Promise<JSONWebKeySet> =>
    (await request(server()).get('/.well-known/jwks.json').expect(200)).body as JSONWebKeySet;

  const verifier = new ReferenceVerifier({
    issuer: TEST_JWT_ISSUER,
    audience: TEST_JWT_AUDIENCE,
    fetchKeySet,
    now: (): number => now,
  });

  /** Restarts the app with the given active key and retired public key paths. */
  async function restart(active: TestKeyPair, retired: readonly string[]): Promise<void> {
    await app?.close();
    useActiveKey(active);
    useRetiredPublicKeys(retired);
    app = await createTestApp();
  }

  async function login(): Promise<string> {
    const response = await request(server())
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
    const dir = tempKeyDir();
    keyA = writeTestKeyPair(dir, 'a');
    keyB = writeTestKeyPair(dir, 'b');
    await restart(keyA, []);
    await request(server())
      .post('/auth/register')
      .send({ email: EMAIL, name: 'Verifier', password: PASSWORD })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    process.env = savedEnv;
  });

  it('should accept a token from POST /auth/login', async () => {
    const payload = await verifier.verify(await login());

    expect(payload.roles).toEqual(['CUSTOMER']);
    expect(verifier.fetchCount).toBe(1);
  });

  it('should reject tokens signed by a key the service does not publish', async () => {
    const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const accessToken = await login();
    const { kid } = decodeProtectedHeader(accessToken);
    const claims = (): SignJWT =>
      new SignJWT({ roles: ['ADMIN'] })
        .setSubject('attacker')
        .setIssuer(TEST_JWT_ISSUER)
        .setAudience(TEST_JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m');

    const sameKid = await claims()
      .setProtectedHeader({ alg: 'RS256', kid })
      .sign(forger.privateKey);
    const ownKid = await claims()
      .setProtectedHeader({ alg: 'RS256', kid: 'forged-kid' })
      .sign(forger.privateKey);

    await expect(verifier.verify(sameKid)).rejects.toThrow();
    await expect(verifier.verify(ownKid)).rejects.toThrow('unknown kid');
  });

  it('should refetch after a rotation and accept the new token and the old one', async () => {
    const oldToken = await login();
    await restart(keyB, [keyA.publicKeyPath]);
    now += REFETCH_INTERVAL_MS;
    const before = verifier.fetchCount;

    const newToken = await login();
    await expect(verifier.verify(newToken)).resolves.toBeDefined();

    expect(verifier.fetchCount).toBe(before + 1);
    await expect(verifier.verify(oldToken)).resolves.toBeDefined();
    expect(verifier.fetchCount).toBe(before + 1);
  });
});
