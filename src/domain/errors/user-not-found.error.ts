/** Raised when no user has the requested id (`GET /users/{id}`). Maps to HTTP 404. */
export class UserNotFoundError extends Error {
  /** Creates the error with the fixed message `user not found`. */
  constructor() {
    super('user not found');
    this.name = 'UserNotFoundError';
  }
}
