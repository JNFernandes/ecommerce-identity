import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `audit_records`, the append-only audit trail of administrative mutations (constitution
 * XI). A trigger rejects every `UPDATE` and `DELETE`, so rows can only ever be inserted. No foreign
 * keys: the trail is history and outlives any change to users. No secondary index yet: the read
 * endpoint (US-11) adds what its queries need.
 */
export class CreateAuditRecords20261119120000 implements MigrationInterface {
  name = 'CreateAuditRecords20261119120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "audit_records" (
        "id" uuid NOT NULL,
        "actorId" uuid NOT NULL,
        "action" varchar(64) NOT NULL,
        "targetId" uuid NOT NULL,
        "before" jsonb,
        "after" jsonb NOT NULL,
        "occurredAt" timestamptz NOT NULL,
        CONSTRAINT "PK_audit_records" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE FUNCTION "audit_records_reject_change"() RETURNS trigger
         LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'audit records are append-only';
       END
       $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "audit_records_append_only"
         BEFORE UPDATE OR DELETE ON "audit_records"
         FOR EACH ROW EXECUTE FUNCTION "audit_records_reject_change"()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "audit_records_append_only" ON "audit_records"`);
    await queryRunner.query(`DROP FUNCTION "audit_records_reject_change"()`);
    await queryRunner.query(`DROP TABLE "audit_records"`);
  }
}
