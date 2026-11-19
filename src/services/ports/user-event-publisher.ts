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

  /**
   * Redelivers a stored event exactly as it was stored: same topic, same key, same payload (and so
   * the same `eventId`). Used by the outbound retry worker.
   *
   * @param topic The stored topic.
   * @param key The stored message key, sent unchanged.
   * @param payload The stored message value.
   * @throws Error When the broker is unreachable or the send fails.
   */
  abstract republish(topic: string, key: string, payload: Record<string, unknown>): Promise<void>;
}
