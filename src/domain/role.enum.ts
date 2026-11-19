/**
 * Roles a user can hold. Customers register themselves or are created by an admin (`POST /users`);
 * admins come from the startup seed or from an admin (`POST /users`), both with one role. An admin
 * may then change any user's roles (`PUT /users/{id}/roles`), so a user can hold both.
 */
export enum Role {
  /** A shopper with a `customerId`. */
  CUSTOMER = 'CUSTOMER',
  /** A back-office operator, created by the startup seed or by another admin. */
  ADMIN = 'ADMIN',
}
