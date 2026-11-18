/** Raised when an admin asks to disable their own account. Maps to HTTP 409. */
export class CannotDisableSelfError extends Error {
  /** Creates the error with the fixed message `an admin cannot disable their own account`. */
  constructor() {
    super('an admin cannot disable their own account');
    this.name = 'CannotDisableSelfError';
  }
}
