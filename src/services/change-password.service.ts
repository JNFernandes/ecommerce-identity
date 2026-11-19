import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ChangePasswordCommand } from '../commands/change-password.command';
import { JwtConfig } from '../config/configuration';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../domain/errors/invalid-access-token.error';
import { InvalidCredentialsError } from '../domain/errors/invalid-credentials.error';
import { UserValidationError } from '../domain/errors/user-validation.error';
import { PasswordPolicy } from '../domain/password-policy';
import { RefreshToken } from '../domain/refresh-token.aggregate';
import { User } from '../domain/user.aggregate';
import { UserRepository } from '../repositories/user.repository';
import { LoginResult } from './login.service';
import { Clock } from './ports/clock';
import { PasswordHasher } from './ports/password-hasher';
import { RefreshTokenGenerator } from './ports/refresh-token-generator';
import { TokenIssuer } from './ports/token-issuer';

/**
 * Handles `ChangePasswordCommand`: the caller replaces their own password and every other session
 * ends. Orchestration only; the rules live in `User.changePassword` and `PasswordPolicy`.
 *
 * Order of checks: caller missing or not `ACTIVE` (401, as `GET /users/me`) → current password
 * (generic 401) → policy and "differs from current" (400). The current password is checked first,
 * so the policy errors reveal nothing to someone who does not know it.
 *
 * On success, one transaction stores the new hash, revokes every refresh token of the user and
 * stores a new one (new family) for the caller; the access token is signed inside it, so a signing
 * failure keeps nothing. No event is published and no audit record is written (not an admin
 * mutation).
 */
@CommandHandler(ChangePasswordCommand)
export class ChangePasswordService implements ICommandHandler<ChangePasswordCommand, LoginResult> {
  private readonly logger = new Logger(ChangePasswordService.name);
  private readonly refreshTtlSeconds: number;

  /**
   * @param users Reads the caller and runs the password change transaction.
   * @param passwordHasher Verifies the current password and hashes the new one (argon2id).
   * @param tokenIssuer Signs the new access token.
   * @param refreshTokenGenerator Creates the new opaque refresh token and its hash.
   * @param clock Supplies the change time.
   * @param configService Supplies the refresh token lifetime.
   */
  constructor(
    private readonly users: UserRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenIssuer: TokenIssuer,
    private readonly refreshTokenGenerator: RefreshTokenGenerator,
    private readonly clock: Clock,
    configService: ConfigService,
  ) {
    this.refreshTtlSeconds = configService.getOrThrow<JwtConfig>('jwt').refreshTtlSeconds;
  }

  /**
   * Changes the caller's password.
   *
   * @param command The caller id and both plain passwords.
   * @returns A new access token and refresh token, in the login shape.
   * @throws InvalidAccessTokenError `USER_UNAVAILABLE` when the caller is missing or not `ACTIVE`.
   * @throws InvalidCredentialsError When the current password is wrong, or another change was
   * committed after it was checked.
   * @throws UserValidationError When the new password breaks the policy or equals the current one.
   */
  async execute(command: ChangePasswordCommand): Promise<LoginResult> {
    const user = this.assertAvailable(await this.users.findById(command.userId));
    if (!(await this.passwordHasher.verify(command.currentPassword, user.passwordHash))) {
      this.logger.warn(`password change refused: reason=wrong_current_password userId=${user.id}`);
      throw new InvalidCredentialsError();
    }
    PasswordPolicy.assertAcceptable(command.newPassword, user.email);
    // The current password matched the stored hash, so the new one matches it exactly when the two
    // strings are equal: no second (costly) argon2 verification is needed.
    if (command.newPassword === command.currentPassword) {
      throw new UserValidationError('new password must be different from the current password');
    }

    // Hash and generate before the transaction, so no row lock is held during argon2.
    const newHash = await this.passwordHasher.hash(command.newPassword);
    const refresh = this.refreshTokenGenerator.generate();
    const now = this.clock.now();

    const { access, revoked } = await this.users.inPasswordChangeTransaction(async (tx) => {
      const locked = this.assertAvailable(await tx.findByIdForUpdate(user.id));
      if (locked.passwordHash !== user.passwordHash) {
        // A concurrent change committed first: the verified current password is stale.
        throw new InvalidCredentialsError();
      }
      const changed = locked.changePassword(newHash, now);
      await tx.savePasswordHash(changed);
      const revokedCount = await tx.revokeAllRefreshTokens(changed.id, now);
      await tx.insertRefreshToken(
        RefreshToken.issue({
          userId: changed.id,
          tokenHash: refresh.hash,
          issuedAt: now,
          ttlSeconds: this.refreshTtlSeconds,
        }),
      );
      const issued = await this.tokenIssuer.issue(
        { userId: changed.id, customerId: changed.customerId, roles: changed.roles },
        now,
      );
      return { access: issued, revoked: revokedCount };
    });

    this.logger.log(`password changed: userId=${user.id} sessionsRevoked=${revoked}`);
    return {
      accessToken: access.token,
      refreshToken: refresh.value,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
    };
  }

  /** Returns the user when it exists and is `ACTIVE`, else throws the US-05 401. */
  private assertAvailable(user: User | null): User {
    if (user === null || !user.canLogin()) {
      throw new InvalidAccessTokenError(AccessTokenFailureReason.USER_UNAVAILABLE);
    }
    return user;
  }
}
