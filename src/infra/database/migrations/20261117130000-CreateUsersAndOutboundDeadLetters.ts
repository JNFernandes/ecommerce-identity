import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `users` table (case-insensitive unique email, unique `customerId`) and the
 * `outbound_dead_letters` table used to retry events that failed to publish after their commit.
 */
export class CreateUsersAndOutboundDeadLetters20261117130000 implements MigrationInterface {
  name = 'CreateUsersAndOutboundDeadLetters20261117130000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "user_role_enum" AS ENUM ('CUSTOMER', 'ADMIN')`);
    await queryRunner.query(`CREATE TYPE "user_status_enum" AS ENUM ('ACTIVE', 'DISABLED')`);
    await queryRunner.query(
      `CREATE TYPE "outbound_dead_letter_status_enum" AS ENUM ('PENDING_RETRY', 'RESOLVED', 'EXHAUSTED')`,
    );
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL,
        "customerId" uuid,
        "email" varchar(254) NOT NULL,
        "name" varchar(100) NOT NULL,
        "passwordHash" text NOT NULL,
        "roles" "user_role_enum"[] NOT NULL,
        "status" "user_status_enum" NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        CONSTRAINT "PK_users_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_customer_id" UNIQUE ("customerId")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_email_lower" ON "users" (lower("email"))`,
    );
    await queryRunner.query(`
      CREATE TABLE "outbound_dead_letters" (
        "id" uuid NOT NULL,
        "eventId" uuid NOT NULL,
        "topic" varchar NOT NULL,
        "key" varchar NOT NULL,
        "payload" jsonb NOT NULL,
        "error" text NOT NULL,
        "status" "outbound_dead_letter_status_enum" NOT NULL DEFAULT 'PENDING_RETRY',
        "retryCount" integer NOT NULL DEFAULT 0,
        "nextRetryAt" timestamptz NOT NULL DEFAULT now(),
        "lastAttemptAt" timestamptz,
        "lastError" text,
        "resolvedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_outbound_dead_letters_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbound_dead_letters_status_next_retry_at" ON "outbound_dead_letters" ("status", "nextRetryAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_outbound_dead_letters_status_next_retry_at"`);
    await queryRunner.query(`DROP TABLE "outbound_dead_letters"`);
    await queryRunner.query(`DROP INDEX "UQ_users_email_lower"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "outbound_dead_letter_status_enum"`);
    await queryRunner.query(`DROP TYPE "user_status_enum"`);
    await queryRunner.query(`DROP TYPE "user_role_enum"`);
  }
}
