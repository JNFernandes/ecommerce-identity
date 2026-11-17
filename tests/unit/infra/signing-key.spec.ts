import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSigningKey, SigningKeyError } from '../../../src/infra/security/signing-key';

/** Writes `content` to a new temp file and returns its path. */
function tempFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'signing-key-spec-')), 'key.pem');
  writeFileSync(path, content);
  return path;
}

/** PEM export of a private key. */
function pem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
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

  it('should load the key file through the key ring', async () => {
    const key = await loadSigningKey(tempFile(pem(rsa.privateKey)));

    expect(key.privateKey.asymmetricKeyType).toBe('rsa');
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
});
