import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { RegisterCustomerCommand } from '../commands/register-customer.command';
import { Email } from '../domain/email.value-object';
import { PasswordPolicy } from '../domain/password-policy';
import { User } from '../domain/user.aggregate';
import { UserName } from '../domain/user-name.value-object';
import { UserRepository } from '../repositories/user.repository';
import { PasswordHasher } from './ports/password-hasher';

/**
 * Handles `RegisterCustomerCommand`: applies the domain rules, hashes the password and stores the
 * new customer. Orchestration only; the rules live in the domain.
 */
@CommandHandler(RegisterCustomerCommand)
export class RegisterCustomerService implements ICommandHandler<RegisterCustomerCommand, User> {
  /**
   * @param passwordHasher Hashes the plain password (argon2id).
   * @param userRepository Persists the new user.
   */
  constructor(
    private readonly passwordHasher: PasswordHasher,
    private readonly userRepository: UserRepository,
  ) {}

  /**
   * Registers a customer. The password policy is checked before hashing, so invalid input never
   * pays the hashing cost.
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
    return user;
  }
}
