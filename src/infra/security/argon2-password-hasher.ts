import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { argon2id, hash, verify } from 'argon2';
import { randomBytes } from 'node:crypto';
import { Argon2Config } from '../../config/configuration';
import { PasswordHasher } from '../../services/ports/password-hasher';

/**
 * `PasswordHasher` backed by argon2id, with memory, time and parallelism costs from the `argon2`
 * configuration. A random salt is generated per hash. Never logs its input or output. On module
 * init it hashes a random secret once, to serve as the dummy hash for unknown emails.
 */
@Injectable()
export class Argon2PasswordHasher extends PasswordHasher implements OnModuleInit {
  private readonly options: Argon2Config;
  private dummy: string | undefined;

  /** @param configService Supplies the `argon2` configuration section. */
  constructor(configService: ConfigService) {
    super();
    this.options = configService.getOrThrow<Argon2Config>('argon2');
  }

  /**
   * Hashes a plain password with argon2id.
   *
   * @param plain The plain password.
   * @returns The PHC string, `$argon2id$v=19$m=…,t=…,p=…$salt$digest`.
   */
  hash(plain: string): Promise<string> {
    return hash(plain, {
      type: argon2id,
      memoryCost: this.options.memoryCostKib,
      timeCost: this.options.timeCost,
      parallelism: this.options.parallelism,
    });
  }

  /** Computes the dummy hash from 32 random bytes with the configured parameters. */
  async onModuleInit(): Promise<void> {
    this.dummy = await this.hash(randomBytes(32).toString('base64'));
  }

  /**
   * Verifies a plain password with argon2 (constant-time comparison).
   *
   * @param plain The plain password.
   * @param encoded The stored PHC string.
   * @returns `true` on a match; `false` on a mismatch or a malformed hash.
   */
  async verify(plain: string, encoded: string): Promise<boolean> {
    try {
      return await verify(encoded, plain);
    } catch {
      return false;
    }
  }

  /**
   * The dummy hash computed on module init.
   *
   * @throws Error When called before `onModuleInit`.
   */
  dummyHash(): string {
    if (this.dummy === undefined) {
      throw new Error('dummy hash is not ready: Argon2PasswordHasher was not initialized');
    }
    return this.dummy;
  }
}
