/** Raised when disabling the target would leave no `ACTIVE` admin. Maps to HTTP 409. */
export class LastActiveAdminError extends Error {
  /** Creates the error with the fixed message `the last active admin cannot be disabled`. */
  constructor() {
    super('the last active admin cannot be disabled');
    this.name = 'LastActiveAdminError';
  }
}
