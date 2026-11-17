import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeys, parseCliArgs } from '../../../scripts/keys-generate';
import { loadKeyRing } from '../../../src/infra/security/key-ring';
import { SigningKey } from '../../../src/infra/security/signing-key';

/** Loads a private key file the way the service does at startup. */
async function loadSigningKey(path: string): Promise<SigningKey> {
  return (await loadKeyRing({ activePrivateKeyPath: path, retiredPublicKeyPaths: [] })).activeKey;
}

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

  it('should write a named pair and leave the default pair untouched', async () => {
    const dir = tempDir();
    const defaults = await generateKeys(dir, { force: false });
    const defaultPem = readFileSync(defaults.privateKeyPath, 'utf8');

    const next = await generateKeys(dir, { force: false, name: 'next' });

    expect(next.privateKeyPath).toBe(join(dir, 'next-private.pem'));
    expect(next.publicKeyPath).toBe(join(dir, 'next-public.pem'));
    expect(next.kid).not.toBe(defaults.kid);
    expect((await loadSigningKey(next.privateKeyPath)).kid).toBe(next.kid);
    expect(readFileSync(defaults.privateKeyPath, 'utf8')).toBe(defaultPem);
  });

  it('should refuse to overwrite a named pair without force and overwrite it with force', async () => {
    const dir = tempDir();
    const first = await generateKeys(dir, { force: false, name: 'next' });
    const firstPem = readFileSync(first.privateKeyPath, 'utf8');

    await expect(generateKeys(dir, { force: false, name: 'next' })).rejects.toThrow(
      `refusing to overwrite ${first.privateKeyPath}, ${first.publicKeyPath}`,
    );
    expect(readFileSync(first.privateKeyPath, 'utf8')).toBe(firstPem);

    const second = await generateKeys(dir, { force: true, name: 'next' });
    expect(second.kid).not.toBe(first.kid);
  });

  it.each(['../x', 'a.b', '', 'a/b', 'a b'])(
    'should reject the name %p and write nothing',
    async (name) => {
      const dir = tempDir();

      await expect(generateKeys(dir, { force: true, name })).rejects.toThrow(
        '--name must match ^[A-Za-z0-9_-]+$',
      );
      expect(readdirSync(dir)).toEqual([]);
    },
  );
});

describe('parseCliArgs', () => {
  it('should default to the unnamed pair without force', () => {
    expect(parseCliArgs([])).toEqual({ force: false, name: undefined });
  });

  it('should read --name and --force', () => {
    expect(parseCliArgs(['--name', 'next', '--force'])).toEqual({ force: true, name: 'next' });
    expect(parseCliArgs(['--name=next'])).toEqual({ force: false, name: 'next' });
  });

  it('should reject unknown flags, positionals and a missing name value', () => {
    expect(() => parseCliArgs(['--bogus'])).toThrow();
    expect(() => parseCliArgs(['next'])).toThrow();
    expect(() => parseCliArgs(['--name'])).toThrow();
  });
});
