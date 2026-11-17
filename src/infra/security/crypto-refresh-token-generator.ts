import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  GeneratedRefreshToken,
  RefreshTokenGenerator,
} from '../../services/ports/refresh-token-generator';

/** Number of random bytes in a refresh token (256 bits). */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * `RefreshTokenGenerator` backed by `node:crypto`: 32 random bytes as base64url (43 characters),
 * hashed with SHA-256. A fast hash is enough because the value already has 256 bits of entropy.
 */
@Injectable()
export class CryptoRefreshTokenGenerator extends RefreshTokenGenerator {
  /** Generates a new token and its hash. */
  generate(): GeneratedRefreshToken {
    const value = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    return { value, hash: this.hash(value) };
  }

  /**
   * SHA-256 of the value as 64 lowercase hex characters.
   *
   * @param value The clear value.
   */
  hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
