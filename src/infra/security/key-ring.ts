import { createHash, createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { calculateJwkThumbprint, exportJWK } from 'jose';
import { MIN_RSA_MODULUS_BITS, SigningKey, SigningKeyError } from './signing-key';

/** A key file already read from disk: its path (for error messages only) and its PEM content. */
export interface KeyFile {
  /** Path of the file; error messages name it. */
  path: string;
  /** PEM content. Never logged or put in an error message. */
  pem: string;
}

/**
 * A published RS256 public key. Built from an allowlist, so it holds exactly these six members and
 * never a private parameter.
 */
export interface PublicJwk {
  kty: 'RSA';
  use: 'sig';
  alg: 'RS256';
  /** RFC 7638 SHA-256 thumbprint; equals the `kid` header of tokens signed with this key. */
  kid: string;
  /** RSA modulus, base64url. */
  n: string;
  /** RSA public exponent, base64url. */
  e: string;
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

/**
 * The signing key plus every published public key, with the key set serialized once. The body and
 * its `ETag` are computed in the constructor, so serving them needs no crypto or I/O.
 */
export class KeyRing {
  /** The JWKS response body: `JSON.stringify({ keys })`. */
  readonly json: string;
  /** Strong `ETag` of {@link json}: the quoted base64url SHA-256 of the body. */
  readonly etag: string;

  /**
   * @param activeKey The only key that signs tokens.
   * @param keys The published public keys, the active key first.
   */
  constructor(
    readonly activeKey: SigningKey,
    readonly keys: readonly PublicJwk[],
  ) {
    this.json = JSON.stringify({ keys });
    this.etag = `"${createHash('sha256').update(this.json).digest('base64url')}"`;
  }
}

/** Builds the allowlisted public JWK and its `kid` for an RSA public key. */
async function toPublicJwk(publicKey: KeyObject): Promise<PublicJwk> {
  const { n, e } = await exportJWK(publicKey);
  if (n === undefined || e === undefined) {
    throw new SigningKeyError('RSA public key has no modulus or exponent');
  }
  const kid = await calculateJwkThumbprint({ kty: 'RSA', n, e }, 'sha256');
  return { kty: 'RSA', use: 'sig', alg: 'RS256', kid, n, e };
}

/** Parses the active RS256 private key (PKCS#8 or PKCS#1 PEM, RSA, at least 2048 bits). */
function parseActivePrivateKey({ path, pem }: KeyFile): KeyObject {
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
  return privateKey;
}

/**
 * Builds the key ring from key files already read. Pure: no file-system access.
 *
 * @param active The active private key file (`JWT_PRIVATE_KEY_PATH`).
 * @param retired Retired public key files. Not supported yet: must be empty.
 * @returns The ring with the active key first in the published set.
 * @throws SigningKeyError When a key is unusable. Messages name the file, never the content.
 */
export async function buildKeyRing(active: KeyFile, retired: readonly KeyFile[]): Promise<KeyRing> {
  if (retired.length > 0) {
    throw new SigningKeyError('retired public keys are not supported yet');
  }
  const privateKey = parseActivePrivateKey(active);
  const activeJwk = await toPublicJwk(createPublicKey(privateKey));
  return new KeyRing(new LoadedSigningKey(privateKey, activeJwk.kid), [activeJwk]);
}

/** Where {@link loadKeyRing} reads the keys from. */
export interface KeyRingPaths {
  /** Active private key path (`JWT_PRIVATE_KEY_PATH`); unset fails. */
  activePrivateKeyPath: string | undefined;
  /** Retired public key paths (`JWT_RETIRED_PUBLIC_KEY_PATHS`), in order. */
  retiredPublicKeyPaths: readonly string[];
}

/** Reads a key file, mapping file-system errors to messages that name the path only. */
async function readKeyFile(path: string, kind: string): Promise<KeyFile> {
  try {
    return { path, pem: await readFile(path, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new SigningKeyError(`${kind} file not found: ${path}`);
    }
    throw new SigningKeyError(`${kind} file is not readable: ${path} (${code ?? 'error'})`);
  }
}

/**
 * Reads the key files and builds the key ring. Called once at startup; any failure stops the app.
 *
 * @param paths The active private key path and the retired public key paths.
 * @returns The key ring.
 * @throws SigningKeyError When the active path is unset, a file is missing or unreadable, or a key
 * is unusable. Messages name the file or variable, never the key content.
 */
export async function loadKeyRing(paths: KeyRingPaths): Promise<KeyRing> {
  const { activePrivateKeyPath, retiredPublicKeyPaths } = paths;
  if (activePrivateKeyPath === undefined || activePrivateKeyPath.trim() === '') {
    throw new SigningKeyError('JWT_PRIVATE_KEY_PATH is not set');
  }
  const active = await readKeyFile(activePrivateKeyPath, 'signing key');
  const retired: KeyFile[] = [];
  for (const path of retiredPublicKeyPaths) {
    retired.push(await readKeyFile(path, 'retired public key'));
  }
  return buildKeyRing(active, retired);
}
