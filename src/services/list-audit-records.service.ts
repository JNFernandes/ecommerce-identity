import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import {
  AccessTokenFailureReason,
  InvalidAccessTokenError,
} from '../domain/errors/invalid-access-token.error';
import { AuditPageReadModel } from '../queries/audit-record.read-model';
import { ListAuditRecordsQuery } from '../queries/list-audit-records.query';
import { AuditRecordRepository } from '../repositories/audit-record.repository';
import { UserRepository } from '../repositories/user.repository';

/**
 * Handles `ListAuditRecordsQuery` (`GET /audit`, admins only): re-reads the caller, then reads one
 * filtered page of the audit trail, newest first. Read-only; reads are neither audited nor logged.
 */
@QueryHandler(ListAuditRecordsQuery)
export class ListAuditRecordsService implements IQueryHandler<
  ListAuditRecordsQuery,
  AuditPageReadModel
> {
  /**
   * @param users Re-reads the caller.
   * @param audit Reads the audit trail.
   */
  constructor(
    private readonly users: UserRepository,
    private readonly audit: AuditRecordRepository,
  ) {}

  /**
   * Returns the requested page.
   *
   * @param query Caller, paging and filters.
   * @throws InvalidAccessTokenError `USER_UNAVAILABLE` when the caller is missing or no longer an
   * `ACTIVE` admin (the generic 401).
   */
  async execute(query: ListAuditRecordsQuery): Promise<AuditPageReadModel> {
    const caller = await this.users.findById(query.actingAdminId);
    if (caller === null || !caller.isActiveAdmin()) {
      throw new InvalidAccessTokenError(AccessTokenFailureReason.USER_UNAVAILABLE);
    }
    return this.audit.findPage(query);
  }
}
