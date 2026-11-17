import { Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { RegisterCustomerCommand } from '../commands/register-customer.command';
import { Email } from '../domain/email.value-object';
import { UserRegistered } from '../domain/events/user-registered.event';
import { PasswordPolicy } from '../domain/password-policy';
import { User } from '../domain/user.aggregate';
import { UserName } from '../domain/user-name.value-object';
import { USER_REGISTERED_TOPIC } from '../infra/kafka/kafka.constants';
import { OutboundDeadLetterRepository } from '../repositories/outbound-dead-letter.repository';
import { UserRepository } from '../repositories/user.repository';
import { PasswordHasher } from './ports/password-hasher';
import { UserEventPublisher } from './ports/user-event-publisher';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Handles `RegisterCustomerCommand`: applies the domain rules, hashes the password, stores the new
 * customer and then announces it. Orchestration only; the rules live in the domain.
 *
 * Write flow: the user row is committed first, then `identity.user-registered` is published. A
 * failed publish is logged and dead-lettered (same `eventId`) and the registration still succeeds.
 */
@CommandHandler(RegisterCustomerCommand)
export class RegisterCustomerService implements ICommandHandler<RegisterCustomerCommand, User> {
  private readonly logger = new Logger(RegisterCustomerService.name);

  /**
   * @param passwordHasher Hashes the plain password (argon2id).
   * @param userRepository Persists the new user.
   * @param userEventPublisher Publishes the user's domain events.
   * @param deadLetters Stores events that failed to publish, for retry.
   */
  constructor(
    private readonly passwordHasher: PasswordHasher,
    private readonly userRepository: UserRepository,
    private readonly userEventPublisher: UserEventPublisher,
    private readonly deadLetters: OutboundDeadLetterRepository,
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

    for (const event of user.pullDomainEvents()) {
      await this.publish(event);
    }
    return user;
  }

  /** Publishes one event; on failure logs it and writes it to the dead-letter table. */
  private async publish(event: UserRegistered): Promise<void> {
    try {
      await this.userEventPublisher.publishUserRegistered(event);
    } catch (error) {
      const cause = messageOf(error);
      this.logger.warn(
        `Failed to publish event: topic=${USER_REGISTERED_TOPIC} key=${event.aggregateId} ` +
          `eventId=${event.eventId} aggregateId=${event.aggregateId} cause=${cause}; dead-lettering it`,
      );
      try {
        await this.deadLetters.recordFailure({
          eventId: event.eventId,
          topic: USER_REGISTERED_TOPIC,
          key: event.aggregateId,
          payload: { ...event },
          error: cause,
        });
      } catch (deadLetterError) {
        this.logger.error(
          `Failed to dead-letter event: topic=${USER_REGISTERED_TOPIC} key=${event.aggregateId} ` +
            `eventId=${event.eventId} aggregateId=${event.aggregateId} ` +
            `cause=${messageOf(deadLetterError)}; the event is lost`,
        );
      }
    }
  }
}
