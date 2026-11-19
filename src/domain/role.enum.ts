/**
 * Roles a user can hold, exactly one per user. Customers register themselves or are created by an
 * admin (`POST /users`); admins come from the startup seed or from an admin (`POST /users`).
 */
export enum Role {
  /** A shopper with a `customerId`. */
  CUSTOMER = 'CUSTOMER',
  /** A back-office operator, created by the startup seed or by another admin. */
  ADMIN = 'ADMIN',
}
