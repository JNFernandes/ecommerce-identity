import { Injectable, Logger } from '@nestjs/common';
import { UserRegistered } from '../domain/events/user-registered.event';
import { User } from '../domain/user.aggregate';
import { USER_REGISTERED_TOPIC } from '../infra/kafka/kafka.constants';
import { OutboundDeadLetterRepository } from '../repositories/outbound-dead-letter.repository';
import { UserEventPublisher } from './ports/user-event-publisher';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publishes the domain events a user recorded, **after** the user was committed (constitution IV).
 * Shared by registration (`POST /auth/register`) and admin creation (`POST /users`), so both
 * behave the same.
 *
 * A failed publish never fails the caller: it is logged with topic, key, `eventId`, `aggregateId`
 * and cause, then stored in the outbound dead-letter table with the same `eventId` for the retry
 * worker. If even that fails, an error is logged and the event is lost.
 */
@Injectable()
export class UserEventDispatcher {
  private readonly logger = new Logger(UserEventDispatcher.name);

  /**
   * @param userEventPublisher Publishes user events to the broker.
   * @param deadLetters Stores events that failed to publish, for retry.
   */
  constructor(
    private readonly userEventPublisher: UserEventPublisher,
    private readonly deadLetters: OutboundDeadLetterRepository,
  ) {}

  /**
   * Publishes every event the user recorded since it was built or last dispatched. Never throws.
   *
   * @param user The committed user.
   */
  async dispatch(user: User): Promise<void> {
    for (const event of user.pullDomainEvents()) {
      await this.publish(event);
    }
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
