import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { OutboundDeadLetterStatus } from './outbound-dead-letter-status.enum';

/**
 * An event that failed to publish to Kafka after its database commit (`outbound_dead_letters`
 * table). The retry worker claims due `PENDING_RETRY` rows and republishes them with the same
 * `eventId`.
 */
@Entity('outbound_dead_letters')
@Index('IDX_outbound_dead_letters_status_next_retry_at', ['status', 'nextRetryAt'])
export class OutboundDeadLetterEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** Id of the event; kept on every retry. */
  @Column({ type: 'uuid' })
  eventId!: string;

  /** Kafka topic, for example `identity.user-registered`. */
  @Column({ type: 'varchar' })
  topic!: string;

  /** Kafka message key (the event's `aggregateId`). */
  @Column({ type: 'varchar' })
  key!: string;

  /** The exact event JSON that failed to publish. */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** The original publish failure. */
  @Column({ type: 'text' })
  error!: string;

  /** Retry state; only `PENDING_RETRY` rows are claimed by the retry worker. */
  @Column({
    type: 'enum',
    enum: OutboundDeadLetterStatus,
    enumName: 'outbound_dead_letter_status_enum',
    default: OutboundDeadLetterStatus.PENDING_RETRY,
  })
  status!: OutboundDeadLetterStatus;

  /** Attempts made by the retry worker. */
  @Column({ type: 'int', default: 0 })
  retryCount!: number;

  /** When the row is next due for a retry (due when ≤ now). */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextRetryAt!: Date;

  /** When the retry worker last attempted this row. */
  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  /** Error from the latest failure. */
  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  /** When a retry succeeded. */
  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
