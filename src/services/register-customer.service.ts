import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { RegisterCustomerCommand } from '../commands/register-customer.command';
import { Email } from '../domain/email.value-object';
import { PasswordPolicy } from '../domain/password-policy';
import { User } from '../domain/user.aggregate';
import { UserName } from '../domain/user-name.value-object';
import { UserRepository } from '../repositories/user.repository';
import { PasswordHasher } from './ports/password-hasher';
import { UserEventDispatcher } from './user-event-dispatcher';

/**
 * Handles `RegisterCustomerCommand`: applies the domain rules, hashes the password, stores the new
 * customer and then announces it. Orchestration only; the rules live in the domain.
 *
 * Write flow: the user row is committed first, then `identity.user-registered` is published. A
 * failed publish is logged and dead-lettered (same `eventId`) and the registration still succeeds.
 */
@CommandHandler(RegisterCustomerCommand)
export class RegisterCustomerService implements ICommandHandler<RegisterCustomerCommand, User> {
  /**
   * @param passwordHasher Hashes the plain password (argon2id).
   * @param userRepository Persists the new user.
   * @param events Publishes the user's domain events after the commit (dead-letter fallback).
   */
  constructor(
    private readonly passwordHasher: PasswordHasher,
    private readonly userRepository: UserRepository,
    private readonly events: UserEventDispatcher,
  ) {}

  /**
   * Registers a customer. The password policy is checked before hashing, so invalid input never
   * pays the hashing cost. Publishing happens only after the commit and never fails the call.
   *
   * @param command The raw registration input.
   * @returns The stored customer.
   * @throws UserValidationError When the email, name or password is invalid.
   * @throws DuplicateEmailError When the email is already registered.
   */
  async execute(command: RegisterCustomerCommand): Promise<User> {
    const email = Email.create(command.email);
    const name = UserName.create(command.name);
    PasswordPolicy.assertAcceptable(command.password, email);

    const passwordHash = await this.passwordHasher.hash(command.password);
    const user = User.registerCustomer(email, name, passwordHash);
    await this.userRepository.save(user);

    await this.events.dispatch(user);
    return user;
  }
}
