import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateJwkThumbprint, exportJWK } from 'jose';
import configuration from '../../src/config/configuration';
import { loadKeyRing } from '../../src/infra/security/key-ring';
import { SigningKeyError } from '../../src/infra/security/signing-key';

/** A new empty temp directory. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'key-ring-loading-'));
}

/** Loads a ring with only an active key path and returns the error it fails with. */
async function failureFor(activePrivateKeyPath: string | undefined): Promise<SigningKeyError> {
  const error: unknown = await loadKeyRing({
    activePrivateKeyPath,
    retiredPublicKeyPaths: [],
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SigningKeyError);
  return error as SigningKeyError;
}

describe('loadKeyRing (integration, real files)', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const originalCwd = process.cwd();

  it('should load the active private key from a file and publish it', async () => {
    const path = join(tempDir(), 'private.pem');
    writeFileSync(path, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const ring = await loadKeyRing({ activePrivateKeyPath: path, retiredPublicKeyPaths: [] });

    const kid = await calculateJwkThumbprint(await exportJWK(rsa.publicKey), 'sha256');
    expect(ring.activeKey.kid).toBe(kid);
    expect(ring.keys.map((key) => key.kid)).toEqual([kid]);
  });

  it('should publish the active key then two retired keys in configured order', async () => {
    const dir = tempDir();
    const retiredA = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const retiredB = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const activePath = join(dir, 'active-private.pem');
    const pathA = join(dir, 'a-public.pem');
    const pathB = join(dir, 'b-public.pem');
    writeFileSync(activePath, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(pathA, retiredA.publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(pathB, retiredB.publicKey.export({ type: 'pkcs1', format: 'pem' }));

    const ring = await loadKeyRing({
      activePrivateKeyPath: activePath,
      retiredPublicKeyPaths: [pathB, pathA],
    });

    const kidOf = async (key: typeof rsa.publicKey): Promise<string> =>
      calculateJwkThumbprint(await exportJWK(key), 'sha256');
    const activeKid = await kidOf(rsa.publicKey);
    expect(ring.activeKey.kid).toBe(activeKid);
    expect(ring.keys.map((key) => key.kid)).toEqual([
      activeKid,
      await kidOf(retiredB.publicKey),
      await kidOf(retiredA.publicKey),
    ]);
  });

  describe('retired key files', () => {
    /** Writes the active key to a new temp dir and returns the dir and the active path. */
    function withActiveKey(): { dir: string; activePath: string } {
      const dir = tempDir();
      const activePath = join(dir, 'active-private.pem');
      writeFileSync(activePath, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      return { dir, activePath };
    }

    /** Loads a ring with the given retired paths and returns the error it fails with. */
    async function retiredFailure(
      activePath: string,
      retiredPublicKeyPaths: string[],
    ): Promise<SigningKeyError> {
      const error: unknown = await loadKeyRing({
        activePrivateKeyPath: activePath,
        retiredPublicKeyPaths,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SigningKeyError);
      return error as SigningKeyError;
    }

    it('should name a missing retired file', async () => {
      const { dir, activePath } = withActiveKey();
      const path = join(dir, 'gone-public.pem');

      expect((await retiredFailure(activePath, [path])).message).toBe(
        `retired public key file not found: ${path}`,
      );
    });

    it('should name an unreadable retired file', async () => {
      const { dir, activePath } = withActiveKey();

      expect((await retiredFailure(activePath, [dir])).message).toContain(
        `retired public key file is not readable: ${dir}`,
      );
    });

    it('should reject the active private key file listed as retired', async () => {
      const { activePath } = withActiveKey();

      const { message } = await retiredFailure(activePath, [activePath]);

      expect(message).toBe(`retired keys must be public only: ${activePath}`);
      expect(message).not.toContain('BEGIN');
    });

    it('should load two retired keys from a raw list with blanks and spaces', async () => {
      const { dir, activePath } = withActiveKey();
      process.chdir(dir);
      for (const name of ['a', 'b']) {
        const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
        writeFileSync(
          join(dir, `${name}.pem`),
          pair.publicKey.export({ type: 'spki', format: 'pem' }),
        );
      }
      const saved = process.env.JWT_RETIRED_PUBLIC_KEY_PATHS;
      process.env.JWT_RETIRED_PUBLIC_KEY_PATHS = ' a.pem, ,b.pem,';
      try {
        const { retiredPublicKeyPaths } = configuration().jwt;

        const ring = await loadKeyRing({ activePrivateKeyPath: activePath, retiredPublicKeyPaths });

        expect(retiredPublicKeyPaths).toEqual(['a.pem', 'b.pem']);
        expect(ring.keys).toHaveLength(3);
      } finally {
        process.chdir(originalCwd);
        if (saved === undefined) {
          delete process.env.JWT_RETIRED_PUBLIC_KEY_PATHS;
        } else {
          process.env.JWT_RETIRED_PUBLIC_KEY_PATHS = saved;
        }
      }
    });
  });

  it('should fail when the active path is unset or blank', async () => {
    expect((await failureFor(undefined)).message).toBe('JWT_PRIVATE_KEY_PATH is not set');
    expect((await failureFor('  ')).message).toBe('JWT_PRIVATE_KEY_PATH is not set');
  });

  it('should name the path when the active key file is missing', async () => {
    const path = join(tempDir(), 'missing.pem');

    expect((await failureFor(path)).message).toBe(`signing key file not found: ${path}`);
  });

  it('should name the path when the active key file is not readable', async () => {
    const path = tempDir();

    const { message } = await failureFor(path);

    expect(message).toContain(`signing key file is not readable: ${path}`);
  });
});
