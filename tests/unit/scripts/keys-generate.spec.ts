import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys } from '../../../scripts/keys-generate';
import { loadSigningKey } from '../../../src/infra/security/signing-key';

/** A new empty temp directory. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'keys-generate-spec-'));
}

describe('generateKeys', () => {
  it('should write a key pair that the service can load, with the same kid', async () => {
    const dir = join(tempDir(), 'keys');

    const keys = await generateKeys(dir, { force: false });

    expect(keys.privateKeyPath).toBe(join(dir, 'private.pem'));
    expect(keys.publicKeyPath).toBe(join(dir, 'public.pem'));
    expect(readFileSync(keys.privateKeyPath, 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect(readFileSync(keys.publicKeyPath, 'utf8')).toContain('BEGIN PUBLIC KEY');
    const loaded = await loadSigningKey(keys.privateKeyPath);
    expect(loaded.kid).toBe(keys.kid);
    expect(loaded.privateKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it('should not return key material', async () => {
    const keys = await generateKeys(tempDir(), { force: false });

    expect(JSON.stringify(keys)).not.toContain('BEGIN');
  });

  if (process.platform !== 'win32') {
    it('should make the private key readable by its owner only', async () => {
      const keys = await generateKeys(tempDir(), { force: false });

      expect(statSync(keys.privateKeyPath).mode & 0o777).toBe(0o600);
    });
  }

  it('should refuse to overwrite existing keys without force', async () => {
    const dir = tempDir();
    const first = await generateKeys(dir, { force: false });

    await expect(generateKeys(dir, { force: false })).rejects.toThrow('refusing to overwrite');
    expect((await loadSigningKey(first.privateKeyPath)).kid).toBe(first.kid);
  });

  it('should overwrite existing keys with force', async () => {
    const dir = tempDir();
    const first = await generateKeys(dir, { force: false });

    const second = await generateKeys(dir, { force: true });

    expect(second.kid).not.toBe(first.kid);
    expect((await loadSigningKey(second.privateKeyPath)).kid).toBe(second.kid);
  });
});
