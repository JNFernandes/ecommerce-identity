import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { calculateJwkThumbprint, exportJWK } from 'jose';

/** RSA modulus length of generated keys, in bits. */
export const KEY_BITS = 2048;

/** Allowed key pair names: letters, digits, `_` and `-` only (no separators, no dots). */
export const KEY_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Options of {@link generateKeys}. */
export interface GenerateKeysOptions {
  /** Overwrite existing key files. */
  force: boolean;
  /**
   * Pair name: writes `<name>-private.pem` and `<name>-public.pem`. Unset keeps `private.pem` and
   * `public.pem`. Must match {@link KEY_NAME_PATTERN}.
   */
  name?: string;
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
 * Generates a 2048-bit RSA key pair and writes the private key (PKCS#8, mode 0600) and the public
 * key (SPKI) to `dir`: `private.pem`/`public.pem`, or `<name>-private.pem`/`<name>-public.pem`.
 * Nothing is written when it throws. Never prints or returns key material.
 *
 * @param dir Target directory, created when missing.
 * @param options Set `force` to overwrite existing files and `name` to write a named pair.
 * @throws Error When the name is invalid, or a key file already exists and `force` is not set.
 */
export async function generateKeys(
  dir: string,
  options: GenerateKeysOptions,
): Promise<GeneratedKeys> {
  const { name } = options;
  if (name !== undefined && !KEY_NAME_PATTERN.test(name)) {
    throw new Error('--name must match ^[A-Za-z0-9_-]+$');
  }
  const prefix = name === undefined ? '' : `${name}-`;
  const privateKeyPath = join(dir, `${prefix}private.pem`);
  const publicKeyPath = join(dir, `${prefix}public.pem`);
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

/**
 * Parses the CLI arguments strictly: only `--name <name>` and `--force`; anything else throws.
 *
 * @param args Arguments after the script path.
 * @returns The options for {@link generateKeys}.
 * @throws Error On an unknown flag, a positional argument or a missing `--name` value.
 */
export function parseCliArgs(args: readonly string[]): GenerateKeysOptions {
  const { values } = parseArgs({
    args: [...args],
    options: { name: { type: 'string' }, force: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  });
  return { force: values.force === true, name: values.name };
}

/** CLI: `npm run keys:generate [-- --name <name>] [-- --force]`, writing to `./keys`. */
async function main(): Promise<void> {
  try {
    const keys = await generateKeys(resolve('keys'), parseCliArgs(process.argv.slice(2)));
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
