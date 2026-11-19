import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { OutboundRetryStatus, RetryDecision } from '../domain/outbound/retry-policy';
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

/** A claimed dead-letter row, as handed to the retry handler. No ORM type leaks out. */
export interface OutboundDeadLetterRow {
  /** Row id. */
  id: string;
  /** The event id stored with the row. */
  eventId: string;
  /** The Kafka topic. */
  topic: string;
  /** The Kafka message key, to be sent unchanged. */
  key: string;
  /** The stored message value; any JSON, so the handler must check its shape. */
  payload: unknown;
  /** Attempts made by the retry worker so far. */
  retryCount: number;
}

/** A row processed by `processNextDue` and the decision written for it. */
export interface ProcessedRow {
  /** The row as it was claimed. */
  row: OutboundDeadLetterRow;
  /** The decision that was written. */
  decision: RetryDecision;
}

/** Persisted status for each domain retry status (same values, mapped explicitly). */
const STATUS_OF: Record<OutboundRetryStatus, OutboundDeadLetterStatus> = {
  [OutboundRetryStatus.PENDING_RETRY]: OutboundDeadLetterStatus.PENDING_RETRY,
  [OutboundRetryStatus.RESOLVED]: OutboundDeadLetterStatus.RESOLVED,
  [OutboundRetryStatus.EXHAUSTED]: OutboundDeadLetterStatus.EXHAUSTED,
};

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

  /**
   * Claims and processes the oldest due row of `topic` in one transaction:
   *
   * 1. selects one `PENDING_RETRY` row with `nextRetryAt <= now`, oldest `nextRetryAt` (then
   *    `createdAt`) first, with `FOR UPDATE SKIP LOCKED`, so concurrent callers (other instances)
   *    never get the same row;
   * 2. runs `handler` while the row stays locked;
   * 3. writes the returned decision (`status`, `retryCount`, `lastAttemptAt`, `lastError` and, when
   *    set, `nextRetryAt` / `resolvedAt`; never `error`, `payload` or `key`) and commits.
   *
   * If the handler or the write throws, the transaction rolls back and the row is left exactly as
   * it was, due again; the error propagates.
   *
   * @param topic Only rows of this topic are claimed.
   * @param now Rows with `nextRetryAt <= now` are due.
   * @param handler Attempts the row and returns its next state.
   * @returns The claimed row and the decision written, or `null` when no row is due.
   */
  async processNextDue(
    topic: string,
    now: Date,
    handler: (row: OutboundDeadLetterRow) => Promise<RetryDecision>,
  ): Promise<ProcessedRow | null> {
    return this.repository.manager.transaction(async (manager) => {
      const entity = await manager
        .getRepository(OutboundDeadLetterEntity)
        .createQueryBuilder('row')
        .where('row.topic = :topic', { topic })
        .andWhere('row.status = :status', { status: OutboundDeadLetterStatus.PENDING_RETRY })
        .andWhere('row.nextRetryAt <= :now', { now })
        .orderBy('row.nextRetryAt', 'ASC')
        .addOrderBy('row.createdAt', 'ASC')
        .limit(1)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (entity === null) {
        return null;
      }
      const row: OutboundDeadLetterRow = {
        id: entity.id,
        eventId: entity.eventId,
        topic: entity.topic,
        key: entity.key,
        payload: entity.payload,
        retryCount: entity.retryCount,
      };
      const decision = await handler(row);
      const update: Partial<
        Pick<
          OutboundDeadLetterEntity,
          'status' | 'retryCount' | 'lastAttemptAt' | 'lastError' | 'nextRetryAt' | 'resolvedAt'
        >
      > = {
        status: STATUS_OF[decision.status],
        retryCount: decision.retryCount,
        lastAttemptAt: decision.lastAttemptAt,
        lastError: decision.lastError,
      };
      if (decision.nextRetryAt !== undefined) {
        update.nextRetryAt = decision.nextRetryAt;
      }
      if (decision.resolvedAt !== undefined) {
        update.resolvedAt = decision.resolvedAt;
      }
      await manager.update(OutboundDeadLetterEntity, { id: entity.id }, update);
      return { row, decision };
    });
  }
}
