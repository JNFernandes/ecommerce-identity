import { QueryFailedError } from 'typeorm';

/** PostgreSQL error code for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * True if `error` is a PostgreSQL unique-constraint violation raised through TypeORM.
 *
 * @param error Any thrown value.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError: unknown = error.driverError;
  return (
    typeof driverError === 'object' &&
    driverError !== null &&
    (driverError as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}
