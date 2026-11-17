/** Raised when user input breaks a domain rule (email, name or password). Maps to HTTP 400. */
export class UserValidationError extends Error {
  /**
   * @param message Human-readable reason, safe to return to the client (never contains a password).
   */
  constructor(message: string) {
    super(message);
    this.name = 'UserValidationError';
  }
}
