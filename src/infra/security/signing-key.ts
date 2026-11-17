import { KeyObject } from 'node:crypto';

/** Smallest accepted RSA modulus, in bits. */
export const MIN_RSA_MODULUS_BITS = 2048;

/**
 * Raised when a key of the key ring cannot be loaded. The message names the problem and never contains
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
