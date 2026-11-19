import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row of the append-only audit trail (`audit_records` table). Only ever inserted: a database
 * trigger rejects updates and deletes. Mapped from the domain `AuditRecord` by the repository.
 */
@Entity('audit_records')
export class AuditRecordEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** The admin who made the change. */
  @Column({ type: 'uuid' })
  actorId!: string;

  /** The domain `AuditAction`, e.g. `USER_CREATED`. */
  @Column({ type: 'varchar', length: 64 })
  action!: string;

  /** The user the change applies to. */
  @Column({ type: 'uuid' })
  targetId!: string;

  /** State before the change; `null` for a creation. Never holds secrets. */
  @Column({ type: 'jsonb', nullable: true })
  before!: Record<string, unknown> | null;

  /** State after the change. Never holds secrets. */
  @Column({ type: 'jsonb' })
  after!: Record<string, unknown>;

  /** When the change happened. */
  @Column({ type: 'timestamptz' })
  occurredAt!: Date;
}
