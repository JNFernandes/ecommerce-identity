import { Injectable } from '@nestjs/common';
import { UserRegistered } from '../../domain/events/user-registered.event';
import { UserEventPublisher } from '../../services/ports/user-event-publisher';
import { USER_REGISTERED_TOPIC } from './kafka.constants';
import { LazyKafkaProducer } from './lazy-kafka-producer';

/**
 * Kafka adapter of `UserEventPublisher`. Publishes through `LazyKafkaProducer`, so it never
 * connects at bootstrap. Failures propagate to the caller, which dead-letters the event.
 */
@Injectable()
export class UserEventsProducer extends UserEventPublisher {
  /** @param producer The lazily connected Kafka producer. */
  constructor(private readonly producer: LazyKafkaProducer) {
    super();
  }

  /**
   * Publishes the event on `identity.user-registered`, keyed by `aggregateId`, with a JSON value
   * holding exactly the seven contract fields.
   *
   * @param event The event to publish.
   * @throws Error When Kafka cannot be reached or the send fails.
   */
  async publishUserRegistered(event: UserRegistered): Promise<void> {
    await this.producer.publish(USER_REGISTERED_TOPIC, UserEventsProducer.toPayload(event));
  }

  /**
   * Redelivers a stored message through `LazyKafkaProducer.publishRaw`: the key is not re-derived
   * and the payload is not rebuilt, so the `eventId` is unchanged.
   *
   * @param topic The stored topic.
   * @param key The stored message key.
   * @param payload The stored message value.
   * @throws Error When Kafka cannot be reached or the send fails.
   */
  async republish(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
    await this.producer.publishRaw(topic, key, payload);
  }

  /**
   * The exact message value for a `UserRegistered` event (the contract fields, nothing else).
   *
   * @param event The event to serialize.
   */
  static toPayload(event: UserRegistered): UserRegisteredPayload {
    return {
      eventId: event.eventId,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
      version: event.version,
      customerId: event.customerId,
      email: event.email,
      name: event.name,
    };
  }
}

/** JSON value of an `identity.user-registered` message. */
export interface UserRegisteredPayload {
  eventId: string;
  aggregateId: string;
  occurredAt: string;
  version: number;
  customerId: string;
  email: string;
  name: string;
}
