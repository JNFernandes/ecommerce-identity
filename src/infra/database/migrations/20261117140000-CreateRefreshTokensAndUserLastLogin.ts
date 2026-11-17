import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `refresh_tokens` table (hashed tokens only, unique hash, indexed by user and
 * family) and adds `users."lastLoginAt"`.
 */
export class CreateRefreshTokensAndUserLastLogin20261117140000 implements MigrationInterface {
  name = 'CreateRefreshTokensAndUserLastLogin20261117140000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastLoginAt" timestamptz`,
    );
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "familyId" uuid NOT NULL,
        "tokenHash" char(64) NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "revokedAt" timestamptz,
        "replacedBy" uuid,
        CONSTRAINT "PK_refresh_tokens_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_refresh_tokens_token_hash" UNIQUE ("tokenHash"),
        CONSTRAINT "FK_refresh_tokens_user_id" FOREIGN KEY ("userId")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_user_id" ON "refresh_tokens" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_family_id" ON "refresh_tokens" ("familyId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_refresh_tokens_family_id"`);
    await queryRunner.query(`DROP INDEX "IDX_refresh_tokens_user_id"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "lastLoginAt"`);
  }
}
