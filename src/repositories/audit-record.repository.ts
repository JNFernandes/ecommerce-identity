import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction } from '../domain/audit/audit-action.enum';
import { AuditRecordEntity } from '../infra/database/entities/audit-record.entity';
import { AuditPageReadModel, AuditRecordReadModel } from '../queries/audit-record.read-model';
import { ListAuditRecordsQuery } from '../queries/list-audit-records.query';

/**
 * Reads the audit trail (`audit_records`). Read-only on purpose: records are appended inside the
 * admin transactions and the table rejects updates and deletes.
 */
@Injectable()
export class AuditRecordRepository {
  /** @param repository TypeORM repository of `AuditRecordEntity`. */
  constructor(
    @InjectRepository(AuditRecordEntity)
    private readonly repository: Repository<AuditRecordEntity>,
  ) {}

  /**
   * Reads one page of records matching the filters, newest first (`occurredAt` desc, `id` desc).
   *
   * @param query Paging and filters.
   */
  async findPage(query: ListAuditRecordsQuery): Promise<AuditPageReadModel> {
    const builder = this.repository.createQueryBuilder('record');
    if (query.actorId !== undefined) {
      builder.andWhere('record.actorId = :actorId', { actorId: query.actorId });
    }
    if (query.targetId !== undefined) {
      builder.andWhere('record.targetId = :targetId', { targetId: query.targetId });
    }
    if (query.action !== undefined) {
      builder.andWhere('record.action = :action', { action: query.action });
    }
    const [entities, total] = await builder
      .orderBy('record.occurredAt', 'DESC')
      .addOrderBy('record.id', 'DESC')
      .offset(query.offset)
      .limit(query.limit)
      .getManyAndCount();
    return {
      items: entities.map((entity) => AuditRecordRepository.toReadModel(entity)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /** Maps a stored row to the read model; `createdAt` is the stored `occurredAt`. */
  private static toReadModel(entity: AuditRecordEntity): AuditRecordReadModel {
    return {
      id: entity.id,
      actorId: entity.actorId,
      action: entity.action as AuditAction,
      targetId: entity.targetId,
      before: entity.before,
      after: entity.after,
      createdAt: entity.occurredAt,
    };
  }
}
