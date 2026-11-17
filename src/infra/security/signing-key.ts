import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { calculateJwkThumbprint, exportJWK } from 'jose';

/** Smallest accepted RSA modulus, in bits. */
export const MIN_RSA_MODULUS_BITS = 2048;

/**
 * Raised when the signing key cannot be loaded. The message names the problem and never contains
 * key material.
 */
export class SigningKeyError extends Error {
  /** @param message What is wrong with the key (no key content). */
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyError';
  }
}

/** The RS256 signing key and its key id. Used as the Nest injection token. */
export abstract class SigningKey {
  /** The RSA private key. Never logged or exported. */
  abstract readonly privateKey: KeyObject;
  /** RFC 7638 SHA-256 thumbprint of the public JWK; stable for a given key. */
  abstract readonly kid: string;
}

/** Concrete, immutable `SigningKey`. */
class LoadedSigningKey extends SigningKey {
  constructor(
    readonly privateKey: KeyObject,
    readonly kid: string,
  ) {
    super();
  }
}

/** Reads the file, mapping file-system errors to messages that name the path only. */
async function readKeyFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new SigningKeyError(`signing key file not found: ${path}`);
    }
    throw new SigningKeyError(`signing key file is not readable: ${path} (${code ?? 'error'})`);
  }
}

/**
 * Loads the RS256 private key from a PEM file (PKCS#8 or PKCS#1) and derives its `kid`.
 *
 * @param path The key path (`JWT_PRIVATE_KEY_PATH`).
 * @returns The key and its RFC 7638 thumbprint.
 * @throws SigningKeyError When the path is unset, the file is missing or unreadable, or it does not
 * hold an RSA private key of at least 2048 bits.
 */
export async function loadSigningKey(path: string | undefined): Promise<SigningKey> {
  if (path === undefined || path.trim() === '') {
    throw new SigningKeyError('JWT_PRIVATE_KEY_PATH is not set');
  }
  const pem = await readKeyFile(path);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new SigningKeyError(`signing key file does not hold a private key in PEM: ${path}`);
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new SigningKeyError(
      `signing key must be an RSA private key, got ${privateKey.asymmetricKeyType ?? 'unknown'}: ${path}`,
    );
  }
  const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_MODULUS_BITS) {
    throw new SigningKeyError(
      `signing key must be at least ${MIN_RSA_MODULUS_BITS} bits, got ${bits}: ${path}`,
    );
  }
  const kid = await calculateJwkThumbprint(await exportJWK(createPublicKey(privateKey)), 'sha256');
  return new LoadedSigningKey(privateKey, kid);
}
