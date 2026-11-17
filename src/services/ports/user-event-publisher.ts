import { UserRegistered } from '../../domain/events/user-registered.event';

/**
 * Port for publishing user domain events to the message broker. Used as the Nest injection token.
 * Implementations reject when the event could not be published, so the caller can dead-letter it.
 */
export abstract class UserEventPublisher {
  /**
   * Publishes `identity.user-registered`, keyed by the event's `aggregateId`.
   *
   * @param event The event to publish.
   * @throws Error When the broker is unreachable or the send fails.
   */
  abstract publishUserRegistered(event: UserRegistered): Promise<void>;
}
