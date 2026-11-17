import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateJwkThumbprint, exportJWK } from 'jose';
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

  it('should load the active private key from a file and publish it', async () => {
    const path = join(tempDir(), 'private.pem');
    writeFileSync(path, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const ring = await loadKeyRing({ activePrivateKeyPath: path, retiredPublicKeyPaths: [] });

    const kid = await calculateJwkThumbprint(await exportJWK(rsa.publicKey), 'sha256');
    expect(ring.activeKey.kid).toBe(kid);
    expect(ring.keys.map((key) => key.kid)).toEqual([kid]);
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
