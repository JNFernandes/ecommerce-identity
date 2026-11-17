import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { calculateJwkThumbprint, exportJWK } from 'jose';

/** RSA modulus length of generated keys, in bits. */
export const KEY_BITS = 2048;

/** Options of {@link generateKeys}. */
export interface GenerateKeysOptions {
  /** Overwrite existing key files. */
  force: boolean;
}

/** Where the keys were written and the key id they produce. */
export interface GeneratedKeys {
  /** Path of the PKCS#8 private key (mode 0600). */
  privateKeyPath: string;
  /** Path of the SPKI public key. */
  publicKeyPath: string;
  /** RFC 7638 SHA-256 thumbprint of the public JWK: the `kid` of issued tokens. */
  kid: string;
}

/**
 * Generates a 2048-bit RSA key pair and writes `private.pem` (PKCS#8, mode 0600) and `public.pem`
 * (SPKI) to `dir`. Never prints or returns key material.
 *
 * @param dir Target directory, created when missing.
 * @param options Set `force` to overwrite existing files.
 * @throws Error When a key file already exists and `force` is not set.
 */
export async function generateKeys(
  dir: string,
  options: GenerateKeysOptions,
): Promise<GeneratedKeys> {
  const privateKeyPath = join(dir, 'private.pem');
  const publicKeyPath = join(dir, 'public.pem');
  const existing = [privateKeyPath, publicKeyPath].filter((path) => existsSync(path));
  if (existing.length > 0 && !options.force) {
    throw new Error(`refusing to overwrite ${existing.join(', ')}; pass --force to replace`);
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: KEY_BITS });
  mkdirSync(dir, { recursive: true });
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  chmodSync(privateKeyPath, 0o600);
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  const kid = await calculateJwkThumbprint(await exportJWK(publicKey), 'sha256');
  return { privateKeyPath, publicKeyPath, kid };
}

/** CLI: `npm run keys:generate [-- --force]`, writing to `./keys`. */
async function main(): Promise<void> {
  const force = process.argv.slice(2).includes('--force');
  try {
    const keys = await generateKeys(resolve('keys'), { force });
    process.stdout.write(
      `private key: ${keys.privateKeyPath}\npublic key:  ${keys.publicKeyPath}\nkid:         ${keys.kid}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
