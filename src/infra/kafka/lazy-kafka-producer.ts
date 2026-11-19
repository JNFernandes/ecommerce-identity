import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Producer } from 'kafkajs';
import { KAFKA_PRODUCER } from './kafka.constants';
import { KafkaProducerState } from './kafka-producer-state.enum';

/** An event envelope as required by Constitution Principle VIII. */
export interface EventEnvelope {
  eventId: string;
  aggregateId: string;
  occurredAt: string;
  version: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publishes events to Kafka through a producer that connects **lazily**, on the first publish,
 * never at bootstrap, so the service starts even when Kafka is down (Constitution Principle VIII).
 *
 * All publishes share one memoized connection attempt. If it fails, the memo is cleared (the next
 * publish tries again) and the error propagates to the caller, which dead-letters the event. How
 * long a failed attempt takes is bounded by `KAFKA_CONNECTION_TIMEOUT_MS` and
 * `KAFKA_PRODUCER_RETRIES` (see KafkaModule).
 */
@Injectable()
export class LazyKafkaProducer implements OnApplicationShutdown {
  private readonly logger = new Logger(LazyKafkaProducer.name);
  /** The current (or last successful) connection attempt; null when not connected. */
  private connection: Promise<void> | null = null;
  private currentState: KafkaProducerState = KafkaProducerState.IDLE;

  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: Producer) {}

  /** Connection state, for health reporting. Reading it never connects. */
  get state(): KafkaProducerState {
    return this.currentState;
  }

  /**
   * Publishes one event to `topic`, serialized as JSON and keyed by its `aggregateId`.
   * Rejects when Kafka cannot be reached or the send fails.
   */
  async publish(topic: string, event: EventEnvelope): Promise<void> {
    await this.publishRaw(topic, event.aggregateId, event);
  }

  /**
   * Publishes an already-built message as is: `value` serialized as JSON, `key` sent unchanged.
   * Used to redeliver a stored event without re-deriving its key or rebuilding its payload.
   * Same lazy connection as `publish`; rejects when Kafka cannot be reached or the send fails.
   *
   * @param topic Destination topic.
   * @param key Message key, sent unchanged.
   * @param value Message value, serialized as JSON.
   */
  async publishRaw(topic: string, key: string, value: object): Promise<void> {
    await this.connect();
    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(value) }],
    });
  }

  /** Disconnects if a connection was made (waiting for one in flight); a no-op otherwise. */
  async onApplicationShutdown(): Promise<void> {
    const connection = this.connection;
    if (connection === null) {
      return;
    }
    try {
      await connection;
    } catch {
      return; // never connected
    }
    this.connection = null;
    this.currentState = KafkaProducerState.IDLE;
    await this.producer.disconnect();
  }

  private connect(): Promise<void> {
    if (this.connection === null) {
      const attempt = this.producer.connect().then(
        () => {
          this.logger.log(
            this.currentState === KafkaProducerState.UNAVAILABLE
              ? 'Kafka is available again: producer connected'
              : 'Kafka producer connected',
          );
          this.currentState = KafkaProducerState.CONNECTED;
        },
        (error: unknown) => {
          if (this.connection === attempt) {
            this.connection = null;
          }
          this.currentState = KafkaProducerState.UNAVAILABLE;
          this.logger.warn(
            `Kafka is unreachable: producer could not connect (${messageOf(error)}); ` +
              'the next publish tries again',
          );
          throw error;
        },
      );
      this.connection = attempt;
    }
    return this.connection;
  }
}
