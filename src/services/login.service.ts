import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { LoginCommand } from '../commands/login.command';
import { JwtConfig } from '../config/configuration';
import { Email } from '../domain/email.value-object';
import { InvalidCredentialsError } from '../domain/errors/invalid-credentials.error';
import { RefreshToken } from '../domain/refresh-token.aggregate';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository';
import { UserRepository } from '../repositories/user.repository';
import { Clock } from './ports/clock';
import { PasswordHasher } from './ports/password-hasher';
import { RefreshTokenGenerator } from './ports/refresh-token-generator';
import { TokenIssuer } from './ports/token-issuer';

/** Result of a successful login. Both tokens are secrets: never log them. */
export interface LoginResult {
  /** Signed RS256 access token. */
  accessToken: string;
  /** Opaque refresh token (clear value, returned once). */
  refreshToken: string;
  /** Always `Bearer`. */
  tokenType: 'Bearer';
  /** Access token lifetime in seconds. */
  expiresIn: number;
}

/**
 * Handles `LoginCommand`: checks the credentials, records the login and issues an access token
 * and a refresh token. Orchestration only; the login rules live in the domain.
 */
@CommandHandler(LoginCommand)
export class LoginService implements ICommandHandler<LoginCommand, LoginResult> {
  private readonly logger = new Logger(LoginService.name);
  private readonly refreshTtlSeconds: number;

  /**
   * @param userRepository Loads the user by email.
   * @param refreshTokens Stores the refresh token and the login time together.
   * @param passwordHasher Verifies the password (argon2id).
   * @param tokenIssuer Signs the access token.
   * @param refreshTokenGenerator Creates the opaque refresh token and its hash.
   * @param clock Supplies the login time.
   * @param configService Supplies the refresh token lifetime.
   */
  constructor(
    private readonly userRepository: UserRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenIssuer: TokenIssuer,
    private readonly refreshTokenGenerator: RefreshTokenGenerator,
    private readonly clock: Clock,
    configService: ConfigService,
  ) {
    this.refreshTtlSeconds = configService.getOrThrow<JwtConfig>('jwt').refreshTtlSeconds;
  }

  /**
   * Logs a user in.
   *
   * @param command The raw login input.
   * @returns The access token, the refresh token and the access token lifetime.
   * @throws UserValidationError When the email is badly formed.
   * @throws InvalidCredentialsError When the credentials are not valid.
   */
  async execute(command: LoginCommand): Promise<LoginResult> {
    const email = Email.create(command.email);
    const user = await this.userRepository.findByEmail(email.value);
    if (user === null || !(await this.passwordHasher.verify(command.password, user.passwordHash))) {
      throw new InvalidCredentialsError();
    }

    const now = this.clock.now();
    user.recordLogin(now);
    const access = await this.tokenIssuer.issue(
      { userId: user.id, customerId: user.customerId, roles: user.roles },
      now,
    );
    const refresh = this.refreshTokenGenerator.generate();
    const token = RefreshToken.issue({
      userId: user.id,
      tokenHash: refresh.hash,
      issuedAt: now,
      ttlSeconds: this.refreshTtlSeconds,
    });
    await this.refreshTokens.saveWithLogin(token, user);

    this.logger.log(`login succeeded: userId=${user.id} ip=${command.clientIp ?? 'unknown'}`);
    return {
      accessToken: access.token,
      refreshToken: refresh.value,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
    };
  }
}
