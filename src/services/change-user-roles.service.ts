import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ChangeUserRolesCommand } from '../commands/change-user-roles.command';
import { AuditRecord } from '../domain/audit/audit-record';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../domain/errors/invalid-access-token.error';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import { LastActiveAdminPolicy } from '../domain/last-active-admin-policy';
import { Role } from '../domain/role.enum';
import { User } from '../domain/user.aggregate';
import { toUserSummary, UserSummaryReadModel } from '../queries/user-summary.read-model';
import { AdminTx, UserRepository } from '../repositories/user.repository';
import { Clock } from './ports/clock';
import { UserEventDispatcher } from './user-event-dispatcher';

/** What the role change transaction committed. */
interface RoleChangeOutcome {
  /** The target after the change (or unchanged for a no-op). */
  user: User;
  /** The roles before the request. */
  before: Role[];
  /** Whether the roles changed. */
  changed: boolean;
  /** Number of refresh tokens revoked. */
  revokedTokens: number;
}

/**
 * Handles `ChangeUserRolesCommand` (`PUT /users/{id}/roles`, admins only). Orchestration only: the
 * rules live in `User.changeRoles` and `LastActiveAdminPolicy`.
 *
 * Everything runs in one transaction, in the lock order of `AdminTx` (shared with status changes,
 * so a concurrent role and status change cannot together remove the last `ACTIVE` admin): the
 * admin-changes advisory lock, then the acting admin is re-read, then the target row is locked.
 * The roles are written, every refresh token of the user is revoked when a role was removed, and a
 * `ROLES_CHANGED` audit record is appended, all in the same transaction (constitution XI). A no-op
 * writes nothing. A first `CUSTOMER` grant publishes `identity.user-registered` **after** the
 * commit, with the dead-letter fallback of `UserEventDispatcher` (constitution IV).
 */
@CommandHandler(ChangeUserRolesCommand)
export class ChangeUserRolesService implements ICommandHandler<
  ChangeUserRolesCommand,
  UserSummaryReadModel
> {
  private readonly logger = new Logger(ChangeUserRolesService.name);

  /**
   * @param users Runs the role change transaction.
   * @param events Publishes the `UserRegistered` event of a first `CUSTOMER` grant after commit.
   * @param clock Supplies the change time.
   */
  constructor(
    private readonly users: UserRepository,
    private readonly events: UserEventDispatcher,
    private readonly clock: Clock,
  ) {}

  /**
   * Replaces the user's roles.
   *
   * @param command The target id, the requested roles and the acting admin's id.
   * @returns The user after the request, in the `GET /users/{id}` shape.
   * @throws InvalidAccessTokenError `USER_UNAVAILABLE` when the acting admin is missing or not an
   * `ACTIVE` admin.
   * @throws UserNotFoundError When no user has the target id.
   * @throws UserValidationError When the roles are empty, repeated or unknown.
   * @throws CannotRemoveOwnAdminError When the admin removes `ADMIN` from themselves.
   * @throws LastActiveAdminError When the target is the last `ACTIVE` admin and loses `ADMIN`.
   */
  async execute(command: ChangeUserRolesCommand): Promise<UserSummaryReadModel> {
    const now = this.clock.now();
    const outcome = await this.users.inAdminTransaction((tx) => this.attempt(tx, command, now));

    if (outcome.changed) {
      this.logger.log(
        `user roles changed: actorId=${command.actingAdminId} targetId=${outcome.user.id} ` +
          `before=${outcome.before.join(',')} after=${outcome.user.roles.join(',')} ` +
          `revokedTokens=${outcome.revokedTokens}`,
      );
      await this.events.dispatch(outcome.user);
    }
    return toUserSummary(outcome.user);
  }

  /** The role change transaction: lock, re-check the actor, lock the target, apply, persist. */
  private async attempt(
    tx: AdminTx,
    command: ChangeUserRolesCommand,
    now: Date,
  ): Promise<RoleChangeOutcome> {
    await tx.lockAdminChanges();
    const actor = await tx.findById(command.actingAdminId);
    if (actor === null || !actor.isActiveAdmin()) {
      throw new InvalidAccessTokenError(AccessTokenFailureReason.USER_UNAVAILABLE);
    }
    const user = await tx.findByIdForUpdate(command.targetId);
    if (user === null) {
      throw new UserNotFoundError();
    }
    const before = user.roles;
    // Validation, no-op and self rule first: the self rule wins over the last-admin rule.
    const preview = user.previewRoleChange(command.roles, command.actingAdminId);
    if (!preview.changed) {
      return { user, before, changed: false, revokedTokens: 0 };
    }
    if (preview.removed.includes(Role.ADMIN)) {
      // The advisory lock makes this count exact until the commit.
      const activeAdminCount = await tx.countActiveAdmins();
      LastActiveAdminPolicy.assertCanRemoveAdmin({ target: user, activeAdminCount });
    }
    const result = user.changeRoles(command.roles, command.actingAdminId, now);
    await tx.saveRoles(user);
    const revokedTokens =
      result.removed.length > 0 ? await tx.revokeAllRefreshTokens(user.id, now) : 0;
    await tx.appendAudit(AuditRecord.rolesChanged(command.actingAdminId, user, before, now));
    return { user, before, changed: true, revokedTokens };
  }
}
