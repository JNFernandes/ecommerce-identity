/** Raised when an account already exists for the email (case-insensitive). Maps to HTTP 409. */
export class DuplicateEmailError extends Error {
  /** Creates the error with the fixed message `email already registered`. */
  constructor() {
    super('email already registered');
    this.name = 'DuplicateEmailError';
  }
}
