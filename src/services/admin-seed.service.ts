import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminSeedConfig } from '../config/configuration';
import { AdminSeedDecision, AdminSeedPolicy } from '../domain/admin-seed-policy';
import { Email } from '../domain/email.value-object';
import { PasswordPolicy } from '../domain/password-policy';
import { Role } from '../domain/role.enum';
import { User } from '../domain/user.aggregate';
import { UserName } from '../domain/user-name.value-object';
import { UserRepository } from '../repositories/user.repository';
import { PasswordHasher } from './ports/password-hasher';

/** Seed values that passed the registration rules. */
interface ValidSeed {
  email: Email;
  name: UserName;
  password: string;
}

/**
 * Creates the first administrator at startup, from `ADMIN_EMAIL`, `ADMIN_PASSWORD` and
 * `ADMIN_NAME`, when no admin exists. Runs during `app.init()`, after migrations and before the
 * server accepts requests. Orchestration only: the decisions come from `AdminSeedPolicy` and the
 * value rules from `Email`, `UserName` and `PasswordPolicy`.
 *
 * It never modifies an existing user and never publishes an event. The password is never logged.
 */
@Injectable()
export class AdminSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminSeedService.name);

  /**
   * @param configService Provides the `admin` seed settings.
   * @param userRepository Reads and stores users.
   * @param passwordHasher Hashes the admin password (argon2id).
   */
  constructor(
    private readonly configService: ConfigService,
    private readonly userRepository: UserRepository,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  /** Runs the seed once at startup. Database errors propagate and fail startup. */
  async onApplicationBootstrap(): Promise<void> {
    await this.seed();
  }

  /**
   * Seeds the administrator when no admin exists and the seed is configured.
   *
   * @throws Error Any repository error, so a database outage is never taken for "nothing to seed".
   */
  async seed(): Promise<void> {
    const config = this.configService.getOrThrow<AdminSeedConfig>('admin');
    const adminExists = await this.userRepository.existsWithRole(Role.ADMIN);
    const precheck = AdminSeedPolicy.precheck({
      adminExists,
      configured: config.email !== undefined && config.password !== undefined,
    });
    if (precheck === AdminSeedDecision.SKIP_ADMIN_EXISTS) {
      this.logger.debug('An administrator already exists; admin seed skipped');
      return;
    }
    if (precheck === AdminSeedDecision.SKIP_NOT_CONFIGURED) {
      this.logger.warn('No administrator exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set');
      return;
    }

    const seed = this.validate(config);
    const emailOwner = await this.userRepository.findByEmail(seed.email.value);
    const decision = AdminSeedPolicy.decide({ emailOwner });
    if (decision !== AdminSeedDecision.CREATE) {
      return;
    }

    const passwordHash = await this.passwordHasher.hash(seed.password);
    const admin = User.registerAdmin(seed.email, seed.name, passwordHash);
    await this.userRepository.save(admin);
    this.logger.log(`Administrator seeded: id=${admin.id}`);
  }

  /** Applies the registration rules to the configured values. */
  private validate(config: AdminSeedConfig): ValidSeed {
    const email = Email.create(config.email ?? '');
    const name = UserName.create(config.name);
    const password = config.password ?? '';
    PasswordPolicy.assertAcceptable(password, email);
    return { email, name, password };
  }
}
