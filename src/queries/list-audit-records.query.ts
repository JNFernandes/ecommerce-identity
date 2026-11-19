import { AuditAction } from '../domain/audit/audit-action.enum';

/**
 * Query for one page of audit records (`GET /audit`), newest first. The filters combine with AND;
 * an absent filter matches every record.
 */
export class ListAuditRecordsQuery {
  /**
   * @param actingAdminId The caller, re-read before the trail is returned.
   * @param limit Page size, 1–100.
   * @param offset Number of matching records to skip, ≥ 0.
   * @param actorId Only records written by this admin.
   * @param targetId Only records about this user.
   * @param action Only records of this action.
   */
  constructor(
    readonly actingAdminId: string,
    readonly limit: number,
    readonly offset: number,
    readonly actorId?: string,
    readonly targetId?: string,
    readonly action?: AuditAction,
  ) {}
}
