import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { RefreshCommand } from '../commands/refresh.command';
import { JwtConfig } from '../config/configuration';
import {
  InvalidRefreshTokenError,
  RefreshFailureReason,
} from '../domain/errors/invalid-refresh-token.error';
import { RefreshPolicy } from '../domain/refresh-policy';
import { RefreshToken } from '../domain/refresh-token.aggregate';
import { TokenFamily } from '../domain/token-family';
import { RefreshTokenRepository, RefreshTokenTx } from '../repositories/refresh-token.repository';
import { LoginResult } from './login.service';
import { Clock } from './ports/clock';
import { RefreshTokenGenerator } from './ports/refresh-token-generator';
import { TokenIssuer } from './ports/token-issuer';

/** Ids known about a refresh attempt, for logs only. */
interface AttemptIds {
  userId?: string;
  familyId?: string;
}

/** What the refresh transaction committed. */
type RefreshOutcome =
  | ({ kind: 'issued'; result: LoginResult } & Required<AttemptIds>)
  | ({ kind: 'refused'; reason: RefreshFailureReason } & AttemptIds);

/**
 * Handles `RefreshCommand`: exchanges a refresh token for a new access token and a new refresh
 * token in the same family. Orchestration only; the rules live in `RefreshPolicy`, `RefreshToken`
 * and `TokenFamily`.
 *
 * Everything runs in one transaction under the family lock. A refusal is returned from the
 * transaction, not thrown inside it, so a family revocation commits; the single generic
 * `InvalidRefreshTokenError` is thrown only after the commit.
 */
@CommandHandler(RefreshCommand)
export class RefreshService implements ICommandHandler<RefreshCommand, LoginResult> {
  private readonly logger = new Logger(RefreshService.name);
  private readonly refreshTtlSeconds: number;
  private readonly sessionMaxSeconds: number;

  /**
   * @param refreshTokens Runs the refresh transaction.
   * @param tokenIssuer Signs the access token.
   * @param refreshTokenGenerator Hashes the presented token and creates its successor.
   * @param clock Supplies the refresh time.
   * @param configService Supplies the refresh token lifetime and the session limit.
   */
  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly tokenIssuer: TokenIssuer,
    private readonly refreshTokenGenerator: RefreshTokenGenerator,
    private readonly clock: Clock,
    configService: ConfigService,
  ) {
    const jwt = configService.getOrThrow<JwtConfig>('jwt');
    this.refreshTtlSeconds = jwt.refreshTtlSeconds;
    this.sessionMaxSeconds = jwt.sessionMaxSeconds;
  }

  /**
   * Refreshes a session.
   *
   * @param command The presented refresh token and the client IP.
   * @returns A new access token and refresh token, in the login response shape.
   * @throws InvalidRefreshTokenError For every token or account failure (one generic error).
   */
  async execute(command: RefreshCommand): Promise<LoginResult> {
    const tokenHash = this.refreshTokenGenerator.hash(command.refreshToken);
    const outcome = await this.refreshTokens.inTransaction((tx) => this.attempt(tx, tokenHash));
    const ip = command.clientIp ?? 'unknown';

    if (outcome.kind === 'refused') {
      const ids = `userId=${outcome.userId ?? '-'} familyId=${outcome.familyId ?? '-'} ip=${ip}`;
      if (outcome.reason === RefreshFailureReason.REUSED) {
        this.logger.warn(`refresh token reuse detected: ${ids}`);
      }
      this.logger.warn(`refresh refused: reason=${outcome.reason} ${ids}`);
      throw new InvalidRefreshTokenError(outcome.reason);
    }

    this.logger.log(
      `refresh succeeded: userId=${outcome.userId} familyId=${outcome.familyId} ip=${ip}`,
    );
    return outcome.result;
  }

  /** The refresh transaction: lock, decide, then revoke or rotate. */
  private async attempt(tx: RefreshTokenTx, tokenHash: string): Promise<RefreshOutcome> {
    const found = await tx.findByHash(tokenHash);
    if (found === null) {
      return { kind: 'refused', reason: RefreshFailureReason.UNKNOWN };
    }
    const ids: AttemptIds = { userId: found.userId, familyId: found.familyId };
    await tx.lockFamily(found.familyId);
    const token = await tx.findByHashForUpdate(tokenHash);
    const user = token === null ? null : await tx.findUserById(token.userId);
    const now = this.clock.now();

    const decision = RefreshPolicy.decide({ token, user, now });
    if (decision.kind === 'refuse') {
      if (decision.revokeFamily) {
        await tx.revokeFamily(found.familyId, now);
      }
      return { kind: 'refused', reason: decision.reason, ...ids };
    }

    let expiresAt: Date;
    try {
      const startedAt = (await tx.familyStartedAt(found.familyId)) ?? decision.token.createdAt;
      const family = TokenFamily.create({ startedAt, maxSeconds: this.sessionMaxSeconds });
      expiresAt = family.nextTokenExpiry(now, this.refreshTtlSeconds);
    } catch (error) {
      if (error instanceof InvalidRefreshTokenError) {
        return { kind: 'refused', reason: error.reason, ...ids };
      }
      throw error;
    }

    const { token: presented, user: owner } = decision;
    const access = await this.tokenIssuer.issue(
      { userId: owner.id, customerId: owner.customerId, roles: owner.roles },
      now,
    );
    const generated = this.refreshTokenGenerator.generate();
    const next = RefreshToken.issueInFamily({
      userId: owner.id,
      familyId: presented.familyId,
      tokenHash: generated.hash,
      issuedAt: now,
      expiresAt,
    });
    presented.rotate(next.id, now);
    await tx.saveRotation(presented, next);

    return {
      kind: 'issued',
      userId: owner.id,
      familyId: presented.familyId,
      result: {
        accessToken: access.token,
        refreshToken: generated.value,
        tokenType: 'Bearer',
        expiresIn: access.expiresIn,
      },
    };
  }
}
