import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreateUserCommand } from '../commands/create-user.command';
import { AuditRecord } from '../domain/audit/audit-record';
import { Email } from '../domain/email.value-object';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../domain/errors/invalid-access-token.error';
import { PasswordPolicy } from '../domain/password-policy';
import { User } from '../domain/user.aggregate';
import { UserName } from '../domain/user-name.value-object';
import { toUserSummary, UserSummaryReadModel } from '../queries/user-summary.read-model';
import { UserRepository } from '../repositories/user.repository';
import { Clock } from './ports/clock';
import { PasswordHasher } from './ports/password-hasher';
import { UserEventDispatcher } from './user-event-dispatcher';

/**
 * Handles `CreateUserCommand` (`POST /users`, admins only). Orchestration only: the rules live in
 * `Email`, `UserName`, `PasswordPolicy`, `User.createByAdmin` and `AuditRecord`.
 *
 * Flow: validate → hash (outside any transaction) → one admin transaction (lock admin changes →
 * re-read the acting admin, who may have been disabled since their token was issued → insert the
 * user → append the audit record) → log → publish the user's events after the commit (a customer
 * raises `identity.user-registered`; a failed publish is dead-lettered and never fails the call).
 */
@CommandHandler(CreateUserCommand)
export class CreateUserService implements ICommandHandler<CreateUserCommand, UserSummaryReadModel> {
  private readonly logger = new Logger(CreateUserService.name);

  /**
   * @param passwordHasher Hashes the initial password (argon2id).
   * @param users Runs the admin transaction.
   * @param events Publishes the user's events after the commit.
   * @param clock Supplies the audit time.
   */
  constructor(
    private readonly passwordHasher: PasswordHasher,
    private readonly users: UserRepository,
    private readonly events: UserEventDispatcher,
    private readonly clock: Clock,
  ) {}

  /**
   * Creates the user.
   *
   * @param command The acting admin's id and the raw input.
   * @returns The new user, in the `GET /users/{id}` shape.
   * @throws UserValidationError When the email, name, password or roles break a rule.
   * @throws InvalidAccessTokenError `USER_UNAVAILABLE` when the acting admin is missing or not an
   * `ACTIVE` admin.
   * @throws DuplicateEmailError When the email is already used.
   */
  async execute(command: CreateUserCommand): Promise<UserSummaryReadModel> {
    const email = Email.create(command.email);
    const name = UserName.create(command.name);
    PasswordPolicy.assertAcceptable(command.password, email);
    // Checked before hashing so invalid input never pays the hashing cost.
    User.assertRolesForAdminCreation(command.roles);

    const passwordHash = await this.passwordHasher.hash(command.password);
    const user = User.createByAdmin(email, name, passwordHash, command.roles);

    await this.users.inAdminTransaction(async (tx) => {
      await tx.lockAdminChanges();
      const actor = await tx.findById(command.actingAdminId);
      if (actor === null || !actor.isActiveAdmin()) {
        throw new InvalidAccessTokenError(AccessTokenFailureReason.USER_UNAVAILABLE);
      }
      await tx.insertUser(user);
      await tx.appendAudit(AuditRecord.userCreated(actor.id, user, this.clock.now()));
    });

    this.logger.log(
      `user created: actorId=${command.actingAdminId} targetId=${user.id} ` +
        `roles=${user.roles.join(',')}`,
    );
    await this.events.dispatch(user);
    return toUserSummary(user);
  }
}
