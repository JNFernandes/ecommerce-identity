import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the indexes behind `GET /audit`: newest-first paging (`"occurredAt" DESC, id DESC`) and the
 * same ordering under the `actorId` and `targetId` filters. `action` has three values, so it is
 * served by the paging index.
 */
export class AddAuditRecordIndexes20261119130000 implements MigrationInterface {
  name = 'AddAuditRecordIndexes20261119130000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_records_occurred_at_id" ON "audit_records" ("occurredAt" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_records_actor_occurred_at_id" ON "audit_records" ("actorId", "occurredAt" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_records_target_occurred_at_id" ON "audit_records" ("targetId", "occurredAt" DESC, "id" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_audit_records_target_occurred_at_id"`);
    await queryRunner.query(`DROP INDEX "IDX_audit_records_actor_occurred_at_id"`);
    await queryRunner.query(`DROP INDEX "IDX_audit_records_occurred_at_id"`);
  }
}
