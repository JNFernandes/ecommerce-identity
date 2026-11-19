/**
 * Raised when a change (disabling the target or removing their `ADMIN` role) would leave no
 * `ACTIVE` admin. Maps to HTTP 409.
 */
export class LastActiveAdminError extends Error {
  /**
   * @param message The reason; defaults to `the last active admin cannot be disabled`.
   */
  constructor(message = 'the last active admin cannot be disabled') {
    super(message);
    this.name = 'LastActiveAdminError';
  }
}
