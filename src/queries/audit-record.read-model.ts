import { AuditAction } from '../domain/audit/audit-action.enum';

/** One audit record as shown to admins by `GET /audit`. Never holds secrets or emails. */
export interface AuditRecordReadModel {
  /** Record id. */
  id: string;
  /** The admin who made the change. */
  actorId: string;
  /** What the change was. */
  action: AuditAction;
  /** The user the change applies to. */
  targetId: string;
  /** State before the change, as stored; `null` for a creation. */
  before: Record<string, unknown> | null;
  /** State after the change, as stored. */
  after: Record<string, unknown>;
  /** When the record was written. */
  createdAt: Date;
}

/** One page of audit records matching a `ListAuditRecordsQuery`. */
export interface AuditPageReadModel {
  /** The records of the page, newest first (`createdAt` desc, then `id` desc). */
  items: AuditRecordReadModel[];
  /** Number of records matching the filters, ignoring paging. */
  total: number;
  /** Page size applied. */
  limit: number;
  /** Number of matching records skipped. */
  offset: number;
}
