/**
 * Raised for every failed login: unknown email, wrong password or a user who may not log in.
 * It deliberately carries no detail, so the response never reveals whether an account exists.
 * Maps to HTTP 401.
 */
export class InvalidCredentialsError extends Error {
  /** Creates the error with the fixed message `invalid credentials`. */
  constructor() {
    super('invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
}
