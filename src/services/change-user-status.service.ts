import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ChangeUserStatusCommand } from '../commands/change-user-status.command';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../domain/errors/invalid-access-token.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import { User } from '../domain/user.aggregate';
import { UserStatus } from '../domain/user-status.enum';
import { toUserSummary, UserSummaryReadModel } from '../queries/user-summary.read-model';
import { UserRepository, UserStatusTx } from '../repositories/user.repository';
import { Clock } from './ports/clock';

/** What the status change transaction committed. */
interface StatusChangeOutcome {
  /** The target after the change (or unchanged for a no-op). */
  user: User;
  /** The status before the request. */
  from: UserStatus;
  /** Whether the status changed. */
  changed: boolean;
  /** Number of refresh tokens revoked. */
  revokedTokens: number;
}

/**
 * Handles `ChangeUserStatusCommand` (`PATCH /users/{id}/status`, admins only). Orchestration only:
 * the rules live in `User`.
 *
 * Everything runs in one transaction, in the lock order of `UserStatusTx`: the status-change
 * advisory lock, then the acting admin is re-read (they may have been disabled since their token
 * was issued), then the target row is locked. A disable writes the status and revokes every refresh
 * token of the user in the same transaction. Setting the status a user already has writes nothing.
 */
@CommandHandler(ChangeUserStatusCommand)
export class ChangeUserStatusService implements ICommandHandler<
  ChangeUserStatusCommand,
  UserSummaryReadModel
> {
  private readonly logger = new Logger(ChangeUserStatusService.name);

  /**
   * @param users Runs the status change transaction.
   * @param clock Supplies the change time.
   */
  constructor(
    private readonly users: UserRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * Sets the user's status.
   *
   * @param command The target id, the requested status and the acting admin's id.
   * @returns The user after the request, in the `GET /users/{id}` shape.
   * @throws InvalidAccessTokenError `USER_UNAVAILABLE` when the acting admin is missing or not an
   * `ACTIVE` admin.
   * @throws UserNotFoundError When no user has the target id.
   * @throws CannotDisableSelfError When the admin disables their own account.
   */
  async execute(command: ChangeUserStatusCommand): Promise<UserSummaryReadModel> {
    const now = this.clock.now();
    const outcome = await this.users.inStatusTransaction((tx) => this.attempt(tx, command, now));

    if (outcome.changed) {
      this.logger.log(
        `user status changed: actorId=${command.actingAdminId} targetId=${outcome.user.id} ` +
          `from=${outcome.from} to=${outcome.user.status} revokedTokens=${outcome.revokedTokens}`,
      );
    }
    return toUserSummary(outcome.user);
  }

  /** The status change transaction: lock, re-check the actor, lock the target, apply, persist. */
  private async attempt(
    tx: UserStatusTx,
    command: ChangeUserStatusCommand,
    now: Date,
  ): Promise<StatusChangeOutcome> {
    await tx.lockStatusChanges();
    const actor = await tx.findById(command.actingAdminId);
    if (actor === null || !actor.isActiveAdmin()) {
      throw new InvalidAccessTokenError(AccessTokenFailureReason.USER_UNAVAILABLE);
    }
    const user = await tx.findByIdForUpdate(command.targetId);
    if (user === null) {
      throw new UserNotFoundError();
    }
    const from = user.status;

    if (command.status === UserStatus.DISABLED) {
      const changed = user.disable(command.actingAdminId, now);
      if (!changed) {
        return { user, from, changed, revokedTokens: 0 };
      }
      await tx.saveStatus(user);
      const revokedTokens = await tx.revokeAllRefreshTokens(user.id, now);
      return { user, from, changed, revokedTokens };
    }

    return { user, from, changed: false, revokedTokens: 0 };
  }
}
