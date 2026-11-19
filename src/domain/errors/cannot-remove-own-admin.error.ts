/** Raised when an admin asks to remove the `ADMIN` role from themselves. Maps to HTTP 409. */
export class CannotRemoveOwnAdminError extends Error {
  /** Creates the error with the fixed message `an admin cannot remove their own ADMIN role`. */
  constructor() {
    super('an admin cannot remove their own ADMIN role');
    this.name = 'CannotRemoveOwnAdminError';
  }
}
