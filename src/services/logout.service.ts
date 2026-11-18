import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { LogoutCommand } from '../commands/logout.command';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository';
import { Clock } from './ports/clock';
import { RefreshTokenGenerator } from './ports/refresh-token-generator';

/**
 * Handles `LogoutCommand`: revokes every unrevoked token of the presented token's family. An
 * unknown token is a no-op, so the caller learns nothing about it. Access tokens already issued
 * stay valid until they expire.
 */
@CommandHandler(LogoutCommand)
export class LogoutService implements ICommandHandler<LogoutCommand, void> {
  private readonly logger = new Logger(LogoutService.name);

  /**
   * @param refreshTokens Runs the logout transaction.
   * @param refreshTokenGenerator Hashes the presented token.
   * @param clock Supplies the revocation time.
   */
  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly refreshTokenGenerator: RefreshTokenGenerator,
    private readonly clock: Clock,
  ) {}

  /**
   * Ends the session of a refresh token. Database errors propagate (never a silent success).
   *
   * @param command The presented refresh token and the client IP.
   */
  async execute(command: LogoutCommand): Promise<void> {
    const tokenHash = this.refreshTokenGenerator.hash(command.refreshToken);
    const ended = await this.refreshTokens.inTransaction(async (tx) => {
      const token = await tx.findByHash(tokenHash);
      if (token === null) {
        return null;
      }
      // Family lock before any row lock (see RefreshTokenTx).
      await tx.lockFamily(token.familyId);
      await tx.revokeFamily(token.familyId, this.clock.now());
      return { userId: token.userId, familyId: token.familyId };
    });

    const ip = command.clientIp ?? 'unknown';
    if (ended === null) {
      this.logger.log(`logout: unknown token ip=${ip}`);
      return;
    }
    this.logger.log(`logout: userId=${ended.userId} familyId=${ended.familyId} ip=${ip}`);
  }
}
