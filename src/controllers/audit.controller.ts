import { Controller, Get, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { AuthenticatedPrincipal } from '../domain/authenticated-principal';
import { Role } from '../domain/role.enum';
import { AuditPageResponseDto } from '../dto/audit-page-response.dto';
import { ListAuditRecordsQueryDto } from '../dto/list-audit-records-query.dto';
import { AuditPageReadModel } from '../queries/audit-record.read-model';
import { ListAuditRecordsQuery } from '../queries/list-audit-records.query';
import { CurrentUser } from './auth/current-user.decorator';
import { Roles } from './auth/roles.decorator';

/** The audit trail of administrative mutations, read by admins only. */
@ApiTags('audit')
@Controller('audit')
export class AuditController {
  /** @param queryBus Dispatches the read query. */
  constructor(private readonly queryBus: QueryBus) {}

  /**
   * Lists audit records, newest first, optionally filtered by actor, target and action.
   *
   * @param principal The caller; re-read before the trail is returned.
   * @param query Paging and filters, already validated.
   */
  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'List audit records',
    description:
      'Admins only. One page of the append-only audit trail, newest first (`createdAt` desc, ' +
      'then `id`). Filters combine with AND. `total` counts every matching record. An offset ' +
      'past the end returns no items with the real total.',
  })
  @ApiOkResponse({ type: AuditPageResponseDto })
  @ApiBadRequestResponse({
    description:
      'Invalid, out-of-range, repeated or unknown parameter; `message` lists the problems',
  })
  @ApiUnauthorizedResponse({
    description: 'No valid token, or the caller is no longer an active admin',
  })
  @ApiForbiddenResponse({ description: 'The caller is not an admin' })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: ListAuditRecordsQueryDto,
  ): Promise<AuditPageResponseDto> {
    const page = await this.queryBus.execute<ListAuditRecordsQuery, AuditPageReadModel>(
      new ListAuditRecordsQuery(
        principal.userId,
        query.limit,
        query.offset,
        query.actorId,
        query.targetId,
        query.action,
      ),
    );
    return AuditPageResponseDto.from(page);
  }
}
