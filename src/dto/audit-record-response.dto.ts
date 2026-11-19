import { ApiProperty } from '@nestjs/swagger';
import { AuditAction } from '../domain/audit/audit-action.enum';
import { AuditRecordReadModel } from '../queries/audit-record.read-model';

/**
 * One audit record as returned by `GET /audit`. An explicit allow-list; records never hold
 * passwords, hashes, tokens or emails.
 */
export class AuditRecordResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Record id' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'The admin who made the change' })
  actorId!: string;

  @ApiProperty({ enum: AuditAction, example: AuditAction.ROLES_CHANGED, description: 'Action' })
  action!: AuditAction;

  @ApiProperty({ format: 'uuid', description: 'The user the change applies to' })
  targetId!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { roles: ['CUSTOMER'] },
    description: 'State before the change, as stored; null for a creation',
  })
  before!: Record<string, unknown> | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { roles: ['CUSTOMER', 'ADMIN'] },
    description: 'State after the change, as stored',
  })
  after!: Record<string, unknown>;

  @ApiProperty({ format: 'date-time', description: 'When the record was written (ISO 8601)' })
  createdAt!: string;

  /**
   * Maps a read model to the response.
   *
   * @param record The record.
   */
  static from(record: AuditRecordReadModel): AuditRecordResponseDto {
    const dto = new AuditRecordResponseDto();
    dto.id = record.id;
    dto.actorId = record.actorId;
    dto.action = record.action;
    dto.targetId = record.targetId;
    dto.before = record.before;
    dto.after = record.after;
    dto.createdAt = record.createdAt.toISOString();
    return dto;
  }
}
