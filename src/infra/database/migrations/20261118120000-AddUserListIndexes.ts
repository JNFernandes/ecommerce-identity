import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the indexes behind `GET /users`: one for newest-first paging (`"createdAt" DESC, id DESC`)
 * and one for the case-insensitive email prefix filter (`lower(email) text_pattern_ops`, which a
 * `LIKE 'prefix%'` can use whatever the database collation).
 */
export class AddUserListIndexes20261118120000 implements MigrationInterface {
  name = 'AddUserListIndexes20261118120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_users_created_at_id" ON "users" ("createdAt" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_email_lower_prefix" ON "users" (lower("email") text_pattern_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_users_email_lower_prefix"`);
    await queryRunner.query(`DROP INDEX "IDX_users_created_at_id"`);
  }
}
