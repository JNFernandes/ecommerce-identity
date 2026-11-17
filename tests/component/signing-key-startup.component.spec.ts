import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { calculateJwkThumbprint, decodeProtectedHeader, exportJWK } from 'jose';
import request from 'supertest';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SigningKeyError } from '../../src/infra/security/signing-key';
import {
  createTestApp,
  startPostgres,
  TEST_JWT_ISSUER,
  useTestSigningKey,
  useUnreachableKafka,
} from './support/test-app';

jest.setTimeout(180_000);

const PASSWORD = 'correct-horse-battery';

/** Writes `content` to a new temp file and returns its path. */
function tempFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'startup-key-')), 'key.pem');
  writeFileSync(path, content);
  return path;
}

/** Starts the app and returns the startup error, or fails when it starts. */
async function startupError(): Promise<Error> {
  const outcome: unknown = await createTestApp().then(
    async (app) => {
      await app.close();
      return undefined;
    },
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) {
    throw new Error('expected the app to refuse to start');
  }
  return outcome;
}

/** Asserts the message carries no key material. */
function expectNoKeyMaterial(error: Error): void {
  expect(error.message).not.toContain('BEGIN');
  expect(error.message).not.toContain('MII');
}

describe('signing key at startup (component)', () => {
  const savedEnv = { ...process.env };
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await startPostgres();
    await useUnreachableKafka();
  });

  afterAll(async () => {
    await container?.stop();
    process.env = savedEnv;
  });

  describe('fail fast', () => {
    let validKeyPath: string;

    beforeAll(() => {
      useTestSigningKey();
      validKeyPath = process.env.JWT_PRIVATE_KEY_PATH ?? '';
    });

    afterEach(() => {
      useTestSigningKey();
    });

    it('should refuse to start when JWT_PRIVATE_KEY_PATH is unset', async () => {
      delete process.env.JWT_PRIVATE_KEY_PATH;

      const error = await startupError();

      expect(error).toBeInstanceOf(SigningKeyError);
      expect(error.message).toBe('JWT_PRIVATE_KEY_PATH is not set');
    });

    it('should refuse to start when the key file is missing', async () => {
      process.env.JWT_PRIVATE_KEY_PATH = join(tmpdir(), 'no-such-dir', 'private.pem');

      const error = await startupError();

      expect(error).toBeInstanceOf(SigningKeyError);
      expect(error.message).toContain('not found');
    });

    it('should refuse to start with a non-RSA key', async () => {
      const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      process.env.JWT_PRIVATE_KEY_PATH = tempFile(
        ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      );

      const error = await startupError();

      expect(error).toBeInstanceOf(SigningKeyError);
      expect(error.message).toContain('must be an RSA private key');
      expectNoKeyMaterial(error);
    });

    it('should refuse to start when JWT_ISSUER is unset', async () => {
      process.env.JWT_PRIVATE_KEY_PATH = validKeyPath;
      delete process.env.JWT_ISSUER;

      const error = await startupError();

      expect(error.message).toBe('JWT_ISSUER is not set');
    });
  });

  describe('with a valid key', () => {
    let publicKey: KeyObject;

    beforeAll(() => {
      publicKey = useTestSigningKey();
    });

    /** Starts the app, logs in once, and returns the access token's kid. */
    async function kidOfOneLogin(email: string): Promise<string> {
      const app: INestApplication = await createTestApp();
      try {
        const server = app.getHttpServer();
        await request(server)
          .post('/auth/register')
          .send({ email, name: 'Ana', password: PASSWORD })
          .expect(201);
        const response = await request(server)
          .post('/auth/login')
          .send({ email, password: PASSWORD })
          .expect(200);
        const { accessToken } = response.body as { accessToken: string };
        return decodeProtectedHeader(accessToken).kid ?? '';
      } finally {
        await app.close();
      }
    }

    it('should sign with the key thumbprint as kid, the same across restarts', async () => {
      const expected = await calculateJwkThumbprint(await exportJWK(publicKey), 'sha256');

      const first = await kidOfOneLogin('first@example.com');
      const second = await kidOfOneLogin('second@example.com');

      expect(first).toBe(expected);
      expect(second).toBe(expected);
      expect(process.env.JWT_ISSUER).toBe(TEST_JWT_ISSUER);
    });
  });
});
