import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateJwkThumbprint, exportJWK } from 'jose';
import { loadSigningKey, SigningKeyError } from '../../../src/infra/security/signing-key';

/** Writes `content` to a new temp file and returns its path. */
function tempFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'signing-key-spec-')), 'key.pem');
  writeFileSync(path, content);
  return path;
}

/** PEM export of a private key. */
function pem(key: KeyObject, type: 'pkcs8' | 'pkcs1' = 'pkcs8'): string {
  return key.export({ type, format: 'pem' }).toString();
}

/** Asserts that loading `path` fails with a `SigningKeyError` naming `problem`, without key data. */
async function expectFailure(path: string | undefined, problem: string): Promise<void> {
  const error: unknown = await loadSigningKey(path).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SigningKeyError);
  const { message } = error as SigningKeyError;
  expect(message).toContain(problem);
  expect(message).not.toContain('BEGIN');
  expect(message).not.toContain('MII');
}

describe('loadSigningKey', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

  it('should load a PKCS#8 RSA key and derive the RFC 7638 kid', async () => {
    const key = await loadSigningKey(tempFile(pem(rsa.privateKey)));

    expect(key.privateKey.asymmetricKeyType).toBe('rsa');
    expect(key.kid).toBe(await calculateJwkThumbprint(await exportJWK(rsa.publicKey), 'sha256'));
  });

  it('should accept a PKCS#1 key', async () => {
    await expect(loadSigningKey(tempFile(pem(rsa.privateKey, 'pkcs1')))).resolves.toBeDefined();
  });

  it('should give the same kid across two loads', async () => {
    const path = tempFile(pem(rsa.privateKey));

    const [first, second] = await Promise.all([loadSigningKey(path), loadSigningKey(path)]);

    expect(second.kid).toBe(first.kid);
  });

  it('should fail when the path is unset', async () => {
    await expectFailure(undefined, 'JWT_PRIVATE_KEY_PATH is not set');
    await expectFailure('  ', 'JWT_PRIVATE_KEY_PATH is not set');
  });

  it('should fail when the file does not exist', async () => {
    await expectFailure(join(tmpdir(), 'no-such-dir', 'missing.pem'), 'not found');
  });

  it('should fail when the file is not a key', async () => {
    await expectFailure(tempFile('hello'), 'does not hold a private key');
  });

  it('should fail for a public key', async () => {
    await expectFailure(
      tempFile(rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
      'does not hold a private key',
    );
  });

  it('should fail for an EC key', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });

    await expectFailure(tempFile(pem(ec.privateKey)), 'must be an RSA private key, got ec');
  });

  it('should fail for a 1024-bit RSA key', async () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });

    await expectFailure(tempFile(pem(weak.privateKey)), 'at least 2048 bits, got 1024');
  });
});
