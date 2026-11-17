import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { OutboundDeadLetterEntity } from '../infra/database/entities/outbound-dead-letter.entity';
import { OutboundDeadLetterStatus } from '../infra/database/entities/outbound-dead-letter-status.enum';

/** An event that could not be published, as handed to `recordFailure`. */
export interface FailedPublish {
  /** The event id, kept on every retry. */
  eventId: string;
  /** The Kafka topic. */
  topic: string;
  /** The Kafka message key. */
  key: string;
  /** The exact message value that failed to publish. */
  payload: Record<string, unknown>;
  /** The publish failure, as text. */
  error: string;
}

/**
 * Persists events that failed to publish in `outbound_dead_letters`, for the retry worker.
 * Persistence only.
 */
@Injectable()
export class OutboundDeadLetterRepository {
  /** @param repository TypeORM repository of `OutboundDeadLetterEntity`. */
  constructor(
    @InjectRepository(OutboundDeadLetterEntity)
    private readonly repository: Repository<OutboundDeadLetterEntity>,
  ) {}

  /**
   * Stores a failed publish as `PENDING_RETRY`, due now, with no retries made yet.
   *
   * @param failure The event that failed and why.
   */
  async recordFailure(failure: FailedPublish): Promise<void> {
    const entity = new OutboundDeadLetterEntity();
    entity.id = randomUUID();
    entity.eventId = failure.eventId;
    entity.topic = failure.topic;
    entity.key = failure.key;
    entity.payload = failure.payload;
    entity.error = failure.error;
    entity.status = OutboundDeadLetterStatus.PENDING_RETRY;
    entity.retryCount = 0;
    entity.nextRetryAt = new Date();
    entity.lastAttemptAt = null;
    entity.lastError = failure.error;
    entity.resolvedAt = null;
    await this.repository.save(entity);
  }
}
