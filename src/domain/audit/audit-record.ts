import { randomUUID } from 'node:crypto';
import { User } from '../user.aggregate';
import { UserStatus } from '../user-status.enum';
import { AuditAction } from './audit-action.enum';

/** The fields of an {@link AuditRecord}. */
export interface AuditRecordProps {
  /** Record id. */
  id: string;
  /** The admin who made the change. */
  actorId: string;
  /** What the change did. */
  action: AuditAction;
  /** The user the change applies to. */
  targetId: string;
  /** State before the change; `null` for a creation. */
  before: Record<string, unknown> | null;
  /** State after the change. */
  after: Record<string, unknown>;
  /** When the change happened. */
  occurredAt: Date;
}

/**
 * One entry of the append-only audit trail (constitution XI): who changed what, from what, to
 * what, and when. Immutable once built, and written in the same transaction as the change.
 * `before` and `after` are built here from non-secret fields only: they never hold a password, a
 * password hash or a token.
 */
export class AuditRecord {
  private constructor(private readonly props: AuditRecordProps) {}

  /**
   * The record of an admin creating a user: `before` is `null`, `after` holds only the roles.
   *
   * @param actorId The acting admin's id.
   * @param user The user just created.
   * @param at Time of the creation.
   */
  static userCreated(actorId: string, user: User, at: Date): AuditRecord {
    return new AuditRecord({
      id: randomUUID(),
      actorId,
      action: AuditAction.USER_CREATED,
      targetId: user.id,
      before: null,
      after: { roles: [...user.roles] },
      occurredAt: at,
    });
  }

  /**
   * The record of an admin changing a user's status: `before` and `after` hold only the status.
   * Written only when the status actually changed (a no-op writes nothing).
   *
   * @param actorId The acting admin's id.
   * @param user The user after the change.
   * @param from The status before the change.
   * @param at Time of the change.
   */
  static statusChanged(actorId: string, user: User, from: UserStatus, at: Date): AuditRecord {
    return new AuditRecord({
      id: randomUUID(),
      actorId,
      action: AuditAction.USER_STATUS_CHANGED,
      targetId: user.id,
      before: { status: from },
      after: { status: user.status },
      occurredAt: at,
    });
  }

  /** Record id. */
  get id(): string {
    return this.props.id;
  }

  /** The admin who made the change. */
  get actorId(): string {
    return this.props.actorId;
  }

  /** What the change did. */
  get action(): AuditAction {
    return this.props.action;
  }

  /** The user the change applies to. */
  get targetId(): string {
    return this.props.targetId;
  }

  /** State before the change; `null` for a creation. */
  get before(): Record<string, unknown> | null {
    return this.props.before;
  }

  /** State after the change. */
  get after(): Record<string, unknown> {
    return this.props.after;
  }

  /** When the change happened. */
  get occurredAt(): Date {
    return this.props.occurredAt;
  }
}
