/** Lifecycle status of a user account. */
export enum UserStatus {
  /** The account can sign in. Every new account starts here. */
  ACTIVE = 'ACTIVE',
  /** The account is blocked from signing in. */
  DISABLED = 'DISABLED',
}
