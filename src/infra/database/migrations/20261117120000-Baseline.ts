import { MigrationInterface } from 'typeorm';

/**
 * Empty baseline. It marks the starting point of the schema history so that every later schema
 * change (users, refresh tokens, outbound dead letters) arrives as its own migration.
 */
export class Baseline20261117120000 implements MigrationInterface {
  name = 'Baseline20261117120000';

  public async up(): Promise<void> {
    // Intentionally empty.
  }

  public async down(): Promise<void> {
    // Intentionally empty.
  }
}
