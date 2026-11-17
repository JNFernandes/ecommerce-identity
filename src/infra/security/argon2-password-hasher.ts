import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { argon2id, hash } from 'argon2';
import { Argon2Config } from '../../config/configuration';
import { PasswordHasher } from '../../services/ports/password-hasher';

/**
 * `PasswordHasher` backed by argon2id, with memory, time and parallelism costs from the `argon2`
 * configuration. A random salt is generated per hash. Never logs its input or output.
 */
@Injectable()
export class Argon2PasswordHasher extends PasswordHasher {
  private readonly options: Argon2Config;

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
}
